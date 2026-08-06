import { describe, expect, it } from 'vitest';
import { HrAttendanceFactory, HrPayrollFactory, HrPerformanceFactory } from '../../../../tests/harness';
const { attendanceMetrics, payrollMetrics, performanceScore } = require('./hr.service');
describe('HR attendance metrics',()=>{
  it('should calculate worked time after the configured break',()=>{const a=HrAttendanceFactory.build();expect(attendanceMetrics(a.clock_in,a.clock_out,a.break_minutes)).toMatchObject({worked_minutes:425,late_minutes:0,overtime_minutes:0});});
  it('should calculate late minutes against the 07:00 UTC schedule',()=>{const a=HrAttendanceFactory.buildLate();expect(attendanceMetrics(a.clock_in,a.clock_out,a.break_minutes).late_minutes).toBe(25);});
});
describe('HR performance score',()=>{it('should calculate the canonical average of four competencies',()=>{const review=HrPerformanceFactory.build();expect(performanceScore(review.scores)).toBe(review.final_score);});it('should reject scores outside the 1 to 5 scale',()=>{const review=HrPerformanceFactory.build({scores:{quality:6,productivity:5,collaboration:4,punctuality:3}});expect(()=>performanceScore(review.scores)).toThrow();});});
describe('HR payroll metrics',()=>{
  it('should calculate gross, deductions and net without implicit statutory rates',()=>{const p=HrPayrollFactory.build();expect(payrollMetrics(p)).toMatchObject({gross_cents:p.gross_cents,deductions_cents:p.deductions_cents,net_cents:p.net_cents});});
  it('should never produce a negative net salary',()=>{const p=HrPayrollFactory.build({tax_cents:20000000});expect(payrollMetrics(p).net_cents).toBe(0);});
});
