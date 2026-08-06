'use strict';
const crypto=require('crypto');
const { HrRepository }=require('../infrastructure/pg.repository');
class HrValidationError extends Error{constructor(message){super(message);this.name='HrValidationError';this.statusCode=400;}}
class HrNotFoundError extends Error{constructor(message){super(message);this.name='HrNotFoundError';this.statusCode=404;}}
/** 409 — violação de unicidade (número de colaborador, código, período repetido). */
class HrConflictError extends Error{constructor(message){super(message);this.name='HrConflictError';this.statusCode=409;}}
const text=(v)=>typeof v==='string'?v.trim():'';
const date=(v)=>/^\d{4}-\d{2}-\d{2}$/.test(text(v))?text(v):'';
/**
 * Converte a violação de índice único do PostgreSQL (23505) numa resposta 409
 * com mensagem útil. Sem isto, um número de colaborador repetido devolvia
 * "Erro interno do servidor" e não aparecia sequer nos logs.
 */
async function unique(operation,message){try{return await operation();}catch(err){if(err&&err.code==='23505')throw new HrConflictError(message);throw err;}}
/** Tipos de licença que descontam do saldo anual de férias. */
const BALANCE_CONSUMING_TYPES=['annual'];
async function createDepartment(dto={}){const name=text(dto.name),code=text(dto.code).toUpperCase();if(!name||!code)throw new HrValidationError('Nome e código do departamento são obrigatórios.');return unique(()=>HrRepository.createDepartment({id:crypto.randomUUID(),name,code,manager_name:text(dto.manager_name)||undefined,description:text(dto.description)||undefined}),`Já existe um departamento com o código ${code}.`);}
async function createEmployee(dto={}){const full_name=text(dto.full_name),employee_number=text(dto.employee_number).toUpperCase(),job_title=text(dto.job_title),hire_date=date(dto.hire_date);if(!full_name||!employee_number||!job_title||!hire_date)throw new HrValidationError('Número, nome, cargo e data de admissão são obrigatórios.');const salary=Number(dto.salary_cents)||0;if(salary<0)throw new HrValidationError('O salário não pode ser negativo.');return unique(()=>HrRepository.createEmployee({...dto,id:crypto.randomUUID(),full_name,employee_number,job_title,hire_date,salary_cents:Math.round(salary),employment_type:['permanent','fixed_term','temporary','intern'].includes(dto.employment_type)?dto.employment_type:'permanent'}),`Já existe um colaborador com o número ${employee_number}.`);}
async function updateEmployee(id,dto={}){if(!(await HrRepository.findEmployee(id)))throw new HrNotFoundError('Colaborador não encontrado.');return HrRepository.updateEmployee(id,dto);}
async function createLeave(dto={}){
  const employee=await HrRepository.findEmployee(dto.employee_id);if(!employee)throw new HrNotFoundError('Colaborador não encontrado.');
  const start=date(dto.start_date),end=date(dto.end_date);if(!start||!end||end<start)throw new HrValidationError('Período da licença inválido.');
  // Duas licenças no mesmo dia significam sempre erro de registo — barrar aqui
  // evita descontar o saldo duas vezes pelo mesmo período.
  const overlapping=await HrRepository.findOverlappingLeaves(dto.employee_id,start,end);
  if(overlapping.length)throw new HrConflictError(`O colaborador já tem uma licença de ${overlapping[0].start_date.toISOString?overlapping[0].start_date.toISOString().slice(0,10):overlapping[0].start_date} a ${overlapping[0].end_date.toISOString?overlapping[0].end_date.toISOString().slice(0,10):overlapping[0].end_date} neste período.`);
  const days=Math.floor((Date.parse(end)-Date.parse(start))/86400000)+1;
  return HrRepository.createLeave({id:crypto.randomUUID(),employee_id:dto.employee_id,type:text(dto.type)||'annual',start_date:start,end_date:end,days,reason:text(dto.reason)||undefined});
}
/**
 * Aprova ou recusa uma licença. Ao APROVAR férias, desconta os dias do saldo
 * anual do colaborador — antes disto o saldo era apenas decorativo: o portal
 * mostrava "dias disponíveis" que nunca baixavam.
 *
 * Sem saldo configurado para o ano não há política definida e a aprovação passa
 * (falha aberta, como no resto do sistema). Havendo saldo, é respeitado.
 */
async function decideLeave(id,dto,userId){
  if(!['approved','rejected'].includes(dto.status))throw new HrValidationError('Decisão inválida.');
  const leave=await HrRepository.findLeave(id);
  if(!leave)throw new HrNotFoundError('Pedido de licença não encontrado.');
  if(leave.status!=='pending')throw new HrConflictError(`Este pedido já foi ${leave.status==='approved'?'aprovado':'recusado'}.`);

  if(dto.status==='approved'&&BALANCE_CONSUMING_TYPES.includes(leave.type)){
    const year=Number(String(leave.start_date instanceof Date?leave.start_date.toISOString():leave.start_date).slice(0,4));
    const balance=await HrRepository.findLeaveBalance(leave.employee_id,year);
    if(balance){
      const consumed=await HrRepository.consumeLeaveBalance(leave.employee_id,year,leave.days);
      if(!consumed)throw new HrValidationError(`Saldo de férias insuficiente: pedido de ${leave.days} dia(s), disponíveis ${Number(balance.available_days)}.`);
    }
  }

  const result=await HrRepository.decideLeave(id,dto.status,text(dto.notes)||undefined,userId);
  if(!result)throw new HrConflictError('O pedido deixou de estar pendente.');
  return result;
}
// ─── Assiduidade ─────────────────────────────────────────────────────────────
// O horário é política da EMPRESA, não uma constante no código. O turno
// (`hr_shifts`) define entrada, saída, pausa e dias de trabalho em hora LOCAL;
// o desvio do fuso converte para UTC, que é como as marcações são gravadas.
// Moçambique é UTC+2 o ano inteiro (sem horário de verão).

const DEFAULT_TIMEZONE_OFFSET_MINUTES=Number(process.env.HR_TIMEZONE_OFFSET_MINUTES??120);

/** Turno de omissão para quem ainda não tem um atribuído. */
const DEFAULT_SHIFT=Object.freeze({
  name:'Padrão',
  start_time:process.env.HR_SHIFT_START||'09:00',
  end_time:process.env.HR_SHIFT_END||'18:00',
  break_minutes:Number(process.env.HR_SHIFT_BREAK_MINUTES??60),
  // Vazio = sem regra semanal definida; nenhum dia é tratado como descanso.
  work_days:[],
});

/** 'HH:MM' ou 'HH:MM:SS' → minutos desde a meia-noite. */
function parseClock(value,fallback=0){
  const m=/^(\d{1,2}):(\d{2})/.exec(String(value??''));
  if(!m)return fallback;
  const minutes=Number(m[1])*60+Number(m[2]);
  return Number.isFinite(minutes)?minutes:fallback;
}

/** Minutos de trabalho previstos no turno, já descontada a pausa. */
function shiftNetMinutes(shift=DEFAULT_SHIFT){
  const start=parseClock(shift.start_time,parseClock(DEFAULT_SHIFT.start_time));
  const end=parseClock(shift.end_time,parseClock(DEFAULT_SHIFT.end_time));
  // Turno que atravessa a meia-noite (ex.: 22:00 → 06:00).
  const span=end>start?end-start:end+1440-start;
  return Math.max(0,span-Math.max(0,Number(shift.break_minutes)||0));
}

/**
 * Métricas de uma marcação de ponto. PURA.
 *
 * @param {string} clockIn ISO da entrada
 * @param {string} [clockOut] ISO da saída
 * @param {number} [breakMinutes] pausa efetiva do dia (pode diferir da do turno)
 * @param {{start_time?:string,end_time?:string,break_minutes?:number,work_days?:number[],timezone_offset_minutes?:number}} [shift]
 * @returns {{worked_minutes:number,late_minutes:number,overtime_minutes:number,expected_minutes:number,rest_day:boolean}}
 */
function attendanceMetrics(clockIn,clockOut,breakMinutes=60,shift=DEFAULT_SHIFT){
  const start=Date.parse(clockIn),end=clockOut?Date.parse(clockOut):NaN;
  if(!Number.isFinite(start))throw new HrValidationError('Hora de entrada inválida.');

  const offset=Number(shift?.timezone_offset_minutes??DEFAULT_TIMEZONE_OFFSET_MINUTES);
  const startMinutes=parseClock(shift?.start_time,parseClock(DEFAULT_SHIFT.start_time));

  // Dia civil LOCAL da marcação — é sobre ele que a hora de entrada se aplica.
  const local=new Date(start+offset*60000);
  const expected=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())+(startMinutes-offset)*60000;

  const workDays=Array.isArray(shift?.work_days)?shift.work_days.map(Number).filter(Number.isFinite):[];
  const restDay=workDays.length>0&&!workDays.includes(local.getUTCDay());

  const worked=Number.isFinite(end)?Math.max(0,Math.round((end-start)/60000)-Math.max(0,Number(breakMinutes)||0)):0;
  const expectedMinutes=shiftNetMinutes(shift??DEFAULT_SHIFT);

  // Num dia de descanso não há atraso possível e tudo o que se trabalha é extra.
  const late=restDay?0:Math.max(0,Math.round((start-expected)/60000));
  const overtime=restDay?worked:Math.max(0,worked-expectedMinutes);

  return{worked_minutes:worked,late_minutes:late,overtime_minutes:overtime,expected_minutes:restDay?0:expectedMinutes,rest_day:restDay};
}
/**
 * Turno aplicável a um colaborador: o dele, senão o único turno ativo da
 * empresa (o caso comum de quem só tem um horário), senão o de omissão.
 */
async function resolveShift(employee){
  if(employee?.shift_id){
    const assigned=await HrRepository.findShift(employee.shift_id);
    if(assigned)return assigned;
  }
  const active=await HrRepository.listActiveShifts();
  return active.length===1?active[0]:DEFAULT_SHIFT;
}

async function recordAttendance(dto={},userId){
  const employee=await HrRepository.findEmployee(dto.employee_id);if(!employee)throw new HrNotFoundError('Colaborador não encontrado.');
  const work_date=date(dto.work_date);if(!work_date)throw new HrValidationError('Data de trabalho inválida.');
  const existing=await HrRepository.findAttendance(dto.employee_id,work_date);
  const clock_in=dto.clock_in||existing?.clock_in||new Date().toISOString(),clock_out=dto.clock_out??existing?.clock_out;
  // A pausa do dia pode ser corrigida à mão; por omissão vem do turno.
  const shift=await resolveShift(employee);
  const break_minutes=Math.max(0,Number(dto.break_minutes??existing?.break_minutes??shift.break_minutes??60));
  const {expected_minutes,rest_day,...metrics}=attendanceMetrics(clock_in,clock_out,break_minutes,shift);
  const data={...(existing||{}),employee_id:dto.employee_id,work_date,clock_in,clock_out,break_minutes,...metrics,status:dto.status||existing?.status||(rest_day?'rest_day':'present'),notes:text(dto.notes)||existing?.notes,adjusted_by:userId,adjusted_at:new Date().toISOString()};
  return existing?HrRepository.updateAttendance(existing.id,data):HrRepository.createAttendance({id:crypto.randomUUID(),...data});
}
function payrollMetrics(dto={}){const n=(k)=>Math.max(0,Math.round(Number(dto[k])||0));const base=n('base_salary_cents'),allowances=n('allowances_cents'),bonus=n('bonus_cents'),overtime=n('overtime_cents'),tax=n('tax_cents'),social=n('social_security_cents'),other=n('other_deductions_cents');const gross=base+allowances+bonus+overtime,deductions=tax+social+other;return{base_salary_cents:base,allowances_cents:allowances,bonus_cents:bonus,overtime_cents:overtime,tax_cents:tax,social_security_cents:social,other_deductions_cents:other,gross_cents:gross,deductions_cents:deductions,net_cents:Math.max(0,gross-deductions)};}
/**
 * Abre a folha do período com TODOS os colaboradores ativos.
 * Idempotente por período (índice único (empresa, período)); a corrida entre
 * dois pedidos simultâneos resolve-se devolvendo a folha que ganhou.
 */
async function createPayroll(period){
  if(!/^\d{4}-\d{2}$/.test(text(period)))throw new HrValidationError('Período inválido. Use AAAA-MM.');
  const existing=await HrRepository.findPayrollByPeriod(period);
  if(existing)return HrRepository.getPayroll(existing.id);
  // Sem paginação: `listEmployees` limita a 100 e deixava gente de fora da folha.
  const employees=await HrRepository.listActiveEmployeesForPayroll();
  if(!employees.length)throw new HrValidationError('Não há colaboradores ativos para processar neste período.');
  const items=employees.map(e=>({id:crypto.randomUUID(),employee_id:e.id,base_salary_cents:e.salary_cents}));
  const total=items.reduce((s,i)=>s+i.base_salary_cents,0);
  try{
    return await HrRepository.createPayroll({id:crypto.randomUUID(),period,gross_cents:total,deductions_cents:0,net_cents:total},items);
  }catch(err){
    if(err&&err.code==='23505'){const winner=await HrRepository.findPayrollByPeriod(period);if(winner)return HrRepository.getPayroll(winner.id);}
    throw err;
  }
}
async function updatePayrollItem(payrollId,employeeId,dto){const run=await HrRepository.getPayroll(payrollId);if(!run)throw new HrNotFoundError('Folha salarial não encontrada.');if(run.status!=='draft')throw new HrValidationError('Apenas folhas em rascunho podem ser alteradas.');const current=run.items.find(i=>i.employee_id===employeeId);if(!current)throw new HrNotFoundError('Linha salarial não encontrada.');await HrRepository.updatePayrollItem(payrollId,employeeId,{...payrollMetrics({...current,...dto}),notes:text(dto.notes)||undefined});return HrRepository.refreshPayrollTotals(payrollId);}
async function setPayrollStatus(id,status,userId){const run=await HrRepository.getPayroll(id);if(!run)throw new HrNotFoundError('Folha salarial não encontrada.');if(status==='approved'&&run.status!=='draft')throw new HrValidationError('A folha já foi aprovada.');if(status==='paid'&&run.status!=='approved')throw new HrValidationError('A folha deve ser aprovada antes do pagamento.');return HrRepository.setPayrollStatus(id,status,userId);}
const stages=['applied','screening','interview','offer','hired','rejected'];
async function createJob(dto,userId){const title=text(dto.title);if(!title)throw new HrValidationError('O cargo da vaga é obrigatório.');return HrRepository.createJob({id:crypto.randomUUID(),...dto,title,employment_type:['permanent','fixed_term','temporary','intern'].includes(dto.employment_type)?dto.employment_type:'permanent',openings:Math.max(1,Number(dto.openings)||1),created_by:userId});}
async function createCandidate(dto){if(!text(dto.full_name)||!text(dto.job_id))throw new HrValidationError('Vaga e nome do candidato são obrigatórios.');return HrRepository.createCandidate({id:crypto.randomUUID(),...dto,full_name:text(dto.full_name)});}
async function updateCandidateStage(id,dto,userId){if(!stages.includes(dto.stage))throw new HrValidationError('Etapa de recrutamento inválida.');const c=await HrRepository.updateCandidateStage(id,dto.stage,text(dto.notes)||undefined,userId);if(!c)throw new HrNotFoundError('Candidato não encontrado.');return c;}
function performanceScore(scores={}){const keys=['quality','productivity','collaboration','punctuality'];const values=keys.map(k=>Number(scores[k]));if(values.some(v=>!Number.isFinite(v)||v<1||v>5))throw new HrValidationError('Todas as competências devem ter nota entre 1 e 5.');return Math.round(values.reduce((a,b)=>a+b,0)/values.length*100)/100;}
async function createPerformance(dto,userId){if(!await HrRepository.findEmployee(dto.employee_id))throw new HrNotFoundError('Colaborador não encontrado.');const period=text(dto.period);if(!period)throw new HrValidationError('O período da avaliação é obrigatório.');if(await HrRepository.findPerformance(dto.employee_id,period))throw new HrValidationError('Já existe uma avaliação deste colaborador no período.');return HrRepository.createPerformance({id:crypto.randomUUID(),...dto,period,final_score:performanceScore(dto.scores),reviewer_id:userId});}
async function completePerformance(id,userId){const r=await HrRepository.completePerformance(id,userId);if(!r)throw new HrNotFoundError('Avaliação em rascunho não encontrada.');return r;}
module.exports={performanceScore,shiftNetMinutes,resolveShift,DEFAULT_SHIFT,listDepartments:()=>HrRepository.listDepartments(),createDepartment,listEmployees:async(o)=>{const page=Math.max(Number(o.page)||1,1),pageSize=Math.min(Math.max(Number(o.pageSize)||20,1),100);const r=await HrRepository.listEmployees({...o,limit:pageSize,offset:(page-1)*pageSize});return{...r,page,pageSize};},getEmployee:async(id)=>{const e=await HrRepository.findEmployee(id);if(!e)throw new HrNotFoundError('Colaborador não encontrado.');return e;},createEmployee,updateEmployee,listLeaves:(o)=>HrRepository.listLeaves(o),createLeave,decideLeave,getStats:()=>HrRepository.stats(),listAttendance:(o)=>HrRepository.listAttendance(o),recordAttendance,getAttendanceStats:(date)=>HrRepository.attendanceStats(date),attendanceMetrics,payrollMetrics,createPayroll,listPayroll:()=>HrRepository.listPayroll(),getPayroll:(id)=>HrRepository.getPayroll(id),updatePayrollItem,setPayrollStatus,listJobs:()=>HrRepository.listJobs(),createJob,listCandidates:(jobId)=>HrRepository.listCandidates(jobId),createCandidate,updateCandidateStage,listPerformance:()=>HrRepository.listPerformance(),createPerformance,completePerformance,HrValidationError,HrNotFoundError,HrConflictError};
