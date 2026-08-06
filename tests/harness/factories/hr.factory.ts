export class HrEmployeeFactory {
  static build(overrides: Record<string, unknown> = {}) {
    return { employee_number:'COL-001', full_name:'Ana Matola', job_title:'Gestora de Operações', employment_type:'permanent', hire_date:'2026-01-15', salary_cents:8500000, status:'active', ...overrides };
  }
}
export class HrLeaveFactory {
  static build(overrides: Record<string, unknown> = {}) {
    return { employee_id:'employee-test-0001', type:'annual', start_date:'2026-08-10', end_date:'2026-08-14', reason:'Férias anuais', ...overrides };
  }
}
export class HrAttendanceFactory {
  static build(overrides: Record<string, unknown> = {}) {
    return { employee_id:'employee-test-0001', work_date:'2026-08-01', clock_in:'2026-08-01T06:55:00.000Z', clock_out:'2026-08-01T15:00:00.000Z', break_minutes:60, worked_minutes:425, late_minutes:0, overtime_minutes:0, status:'present', ...overrides };
  }
  static buildLate(overrides: Record<string, unknown> = {}) {
    return this.build({ clock_in:'2026-08-01T07:25:00.000Z', worked_minutes:395, late_minutes:25, ...overrides });
  }
}
export class HrPayrollFactory {
  static build(overrides: Record<string, unknown> = {}) {
    return { base_salary_cents:8500000, allowances_cents:500000, bonus_cents:250000, overtime_cents:100000, tax_cents:850000, social_security_cents:255000, other_deductions_cents:0, gross_cents:9350000, deductions_cents:1105000, net_cents:8245000, ...overrides };
  }
}
export class HrPayslipFactory { static build(overrides:Record<string,unknown>={}){return{payroll_id:'payroll-test-001',period:'2026-08',status:'approved',employee_name:'Ana Matola',employee_number:'COL-001',...HrPayrollFactory.build(),...overrides};} }
export class HrJobFactory { static build(overrides:Record<string,unknown>={}){return{title:'Técnico de Logística',department_id:'dept-test-001',location:'Maputo',employment_type:'permanent',openings:2,status:'open',description:'Apoiar as operações logísticas.',...overrides};} }
export class HrCandidateFactory { static build(overrides:Record<string,unknown>={}){return{job_id:'job-test-001',full_name:'Paulo Cossa',email:'paulo.cossa@example.mz',phone:'+258841234567',stage:'applied',source:'LinkedIn',notes:'Experiência em armazém.',...overrides};} }
export class HrPerformanceFactory { static build(overrides:Record<string,unknown>={}){return{employee_id:'employee-test-0001',period:'2026-S1',scores:{quality:4,productivity:5,collaboration:4,punctuality:3},final_score:4,goals:['Reduzir erros operacionais em 10%'],feedback:'Bom desempenho global.',development_plan:'Formação em liderança.',status:'draft',...overrides};} }
export class HrLeaveBalanceFactory { static build(overrides:Record<string,unknown>={}){return{employee_id:'employee-test-0001',year:2026,entitled_days:22,carried_days:2,used_days:5,...overrides};} }
export class HrShiftFactory { static build(overrides:Record<string,unknown>={}){return{name:'Turno normal',start_time:'07:00',end_time:'16:00',break_minutes:60,work_days:[1,2,3,4,5],active:true,...overrides};} }
export class HrTimeBankFactory { static build(overrides:Record<string,unknown>={}){return{employee_id:'employee-test-0001',entry_date:'2026-08-01',type:'credit',minutes:90,reason:'Operação extraordinária',...overrides};} }
export class HrDocumentFactory { static build(overrides:Record<string,unknown>={}){return{employee_id:'employee-test-0001',type:'contract',title:'Contrato de trabalho',reference:'DOC-2026-001',issued_at:'2026-01-15',expires_at:'2027-01-15',status:'valid',...overrides};} }
export class HrChecklistFactory { static build(overrides:Record<string,unknown>={}){return{employee_id:'employee-test-0001',type:'onboarding',title:'Admissão',due_date:'2026-01-15',items:[{id:'item-1',label:'Contrato assinado',completed:true},{id:'item-2',label:'Equipamento entregue',completed:false}],...overrides};} }
export class HrTrainingFactory { static build(overrides:Record<string,unknown>={}){return{title:'Segurança no trabalho',provider:'Centro de Formação',start_date:'2026-09-01',end_date:'2026-09-02',status:'planned',cost_cents:125000,participant_ids:['employee-test-0001'],...overrides};} }
export class HrBenefitFactory { static build(overrides:Record<string,unknown>={}){return{employee_id:'employee-test-0001',kind:'benefit',name:'Subsídio de comunicação',amount_cents:250000,status:'active',start_date:'2026-01-01',...overrides};} static buildAdvance(overrides:Record<string,unknown>={}){return this.build({kind:'advance',name:'Adiantamento salarial',amount_cents:1000000,balance_cents:750000,installments:4,...overrides});} }
export class HrPortalAccountFactory { static build(overrides:Record<string,unknown>={}){return{employee_id:'employee-test-0001',email:'ana.matola@example.mz',password:'PortalSeguro2026!',...overrides};} }
export class HrPortalDashboardFactory { static build(overrides:Record<string,unknown>={}){return{profile:HrEmployeeFactory.build({id:'employee-test-0001'}),leave_balance:{available_days:19},time_bank_minutes:60,attendance:[],leaves:[],payslips:[],documents:[],trainings:[],benefits:[],performance:[],...overrides};} }
