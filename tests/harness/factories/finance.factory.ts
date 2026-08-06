export class FinanceAccountFactory { static build(overrides:Record<string,unknown>={}){return{code:'1.1.01',name:'Caixa',category:'asset',active:true,...overrides};} }
export class FinanceEntryFactory {
 static buildReceivable(overrides:Record<string,unknown>={}){return{type:'receivable',description:'Serviço de entrega',party_name:'Cliente Exemplo',amount_cents:125000,due_date:'2026-08-15',status:'open',account_id:'account-revenue-001',...overrides};}
 static buildPayable(overrides:Record<string,unknown>={}){return{type:'payable',description:'Combustível da frota',party_name:'Fornecedor Exemplo',amount_cents:50000,due_date:'2026-08-10',status:'open',account_id:'account-expense-001',...overrides};}
}
export class FinanceSummaryFactory { static build(overrides:Record<string,unknown>={}){return{cash_balance_cents:75000,receivable_open_cents:125000,payable_open_cents:50000,overdue_cents:0,income_paid_cents:125000,expense_paid_cents:50000,...overrides};} }
