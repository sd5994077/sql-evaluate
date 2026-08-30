import { describe, expect, it } from "vitest";
import { parseShowplan } from "./showplan";

const actualPlan = `<?xml version="1.0" encoding="utf-8"?>
<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
 <BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT * FROM dbo.Fact" StatementType="SELECT" StatementSubTreeCost="9">
  <QueryPlan><MemoryGrantInfo RequestedMemory="800000" GrantedMemory="800000" MaxUsedMemory="50000" />
   <RelOp NodeId="1" PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="1000" EstimatedTotalSubtreeCost="9">
    <Warnings SpillToTempDb="1"><HashSpillDetails GrantedMemoryKb="1024" /></Warnings>
    <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="200000" /></RunTimeInformation>
   </RelOp>
  </QueryPlan>
 </StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>`;

const nestedPlan = `<?xml version="1.0" encoding="utf-8"?>
<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
 <BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT nested" StatementType="SELECT">
  <QueryPlan>
   <RelOp NodeId="1" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="1">
    <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1" /></RunTimeInformation>
    <NestedLoops><RelOp NodeId="2" PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="1000">
     <Warnings><HashSpillDetails GrantedMemoryKb="1024" /></Warnings>
     <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="200000" /></RunTimeInformation>
     <Hash><RelOp NodeId="3" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="200000">
      <IndexScan><Object Schema="[dbo]" Table="[Fact]" Index="[IX_Fact]" /></IndexScan>
     </RelOp></Hash>
    </RelOp></NestedLoops>
   </RelOp>
  </QueryPlan>
 </StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>`;

const serializedPlan = `<?xml version="1.0" encoding="utf-8"?>
<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
 <BatchSequence><Batch><Statements><StmtSimple StatementText="INSERT dbo.Target SELECT dbo.FilterUdf(Id) FROM dbo.Source" StatementType="INSERT" QueryHash="0x1111" QueryPlanHash="0x2222" StatementOptmLevel="FULL" StatementOptmEarlyAbortReason="TimeOut">
  <QueryPlan DegreeOfParallelism="1" NonParallelPlanReason="TSQLUserDefinedFunctionsNotParallelizable" CompileTime="45" CompileCPU="40" CompileMemory="1024">
   <RelOp NodeId="1" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="100" Parallel="0"><IndexScan><Predicate><ScalarOperator ScalarString="[dbo].[FilterUdf]([Id])"><UserDefinedFunction /></ScalarOperator></Predicate></IndexScan></RelOp>
  </QueryPlan>
 </StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>`;

describe("Showplan parser", () => {
  it("reads statements, runtime rows, spills, and grants", () => {
    const plan = parseShowplan(actualPlan, "source", "test.sqlplan");
    expect(plan.isActual).toBe(true);
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].operators[0].actualRows).toBe(200000);
    expect(plan.statements[0].operators[0].warnings).toContain("Spill to tempdb");
    expect(plan.statements[0].memoryGrant?.grantedKb).toBe(800000);
  });

  it("rejects non-plan XML and DOCTYPE declarations", () => {
    expect(() => parseShowplan("<root />", "source", "x.xml")).toThrow(/Showplan/i);
    expect(() => parseShowplan("<!DOCTYPE x><ShowPlanXML />", "source", "x.xml")).toThrow(/DOCTYPE/);
  });

  it("keeps runtime evidence, warnings, and object names scoped to their operator", () => {
    const plan = parseShowplan(nestedPlan, "source", "nested.sqlplan");
    const [parent, child, scan] = plan.statements[0].operators;
    expect(parent.actualRows).toBe(1);
    expect(parent.warnings).toEqual([]);
    expect(parent.objectName).toBeUndefined();
    expect(child.actualRows).toBe(200000);
    expect(child.warnings).toContain("Runtime spill");
    expect(child.objectName).toBeUndefined();
    expect(scan.objectName).toBe("[dbo].[Fact].[IX_Fact]");
  });

  it("retains query identity, compile context, and an explicit nonparallel reason", () => {
    const statement = parseShowplan(serializedPlan, "source", "root.sqlplan").statements[0];
    expect(statement.queryIdentity?.queryHash).toBe("0x1111");
    expect(statement.queryIdentity?.queryPlanHash).toBe("0x2222");
    expect(statement.nonParallelPlanReason).toBe("TSQLUserDefinedFunctionsNotParallelizable");
    expect(statement.earlyAbortReason).toBe("TimeOut");
    expect(statement.optimizationLevel).toBe("FULL");
    expect(statement.degreeOfParallelism).toBe(1);
    expect(statement.compileTimeMs).toBe(45);
    expect(statement.compileCpuMs).toBe(40);
    expect(statement.compileMemoryKb).toBe(1024);
    expect(statement.operators[0].hasScalarFunction).toBe(true);
    expect(statement.operators[0].warnings).not.toContain("Residual predicate");
    expect(statement.operators[0].nonSargablePredicate).toBeNull();
  });

  it("drops malformed compile numerics and emits value-free warnings", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1"><QueryPlan CompileTime="12ms" CompileCPU="Infinity" CompileMemory="-1"><RelOp NodeId="0" PhysicalOp="Constant Scan" LogicalOp="Constant Scan" /></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const plan = parseShowplan(xml, "source", "malformed.sqlplan");
    expect(plan.statements[0]).toMatchObject({ compileTimeMs: null, compileCpuMs: null, compileMemoryKb: null });
    expect(plan.warnings).toHaveLength(3);
    expect(plan.warnings.join(" ")).toMatch(/CompileTime.*CompileCPU.*CompileMemory/);
    expect(plan.warnings.join(" ")).not.toMatch(/12ms|Infinity|-1/);
  });

  it("distinguishes ordinary scan predicates from seek residuals", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT Id FROM dbo.T WHERE Id &gt; 10"><QueryPlan><RelOp NodeId="1" PhysicalOp="Index Scan" LogicalOp="Index Scan"><IndexScan><Predicate><ScalarOperator ScalarString="[dbo].[T].[Id]&gt;(10)" /></Predicate></IndexScan></RelOp><RelOp NodeId="2" PhysicalOp="Index Seek" LogicalOp="Index Seek"><IndexScan><SeekPredicates><SeekPredicateNew><SeekKeys><Prefix ScanType="EQ"><RangeColumns><ColumnReference Table="[T]" Column="[Id]" /></RangeColumns><RangeExpressions><ScalarOperator ScalarString="(10)" /></RangeExpressions></Prefix></SeekKeys></SeekPredicateNew></SeekPredicates><Predicate><ScalarOperator ScalarString="[dbo].[T].[Flag]=(1)" /></Predicate></IndexScan></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const plan = parseShowplan(xml, "source", "predicates.sqlplan");
    const [scan, seek] = plan.statements[0].operators;
    expect(scan).toMatchObject({ predicate: "[dbo].[T].[Id]>(10)", seekPredicate: null, residualPredicate: null, nonSargablePredicate: null });
    expect(scan.warnings).not.toContain("Residual predicate");
    expect(seek.seekPredicate).toBe("(10)");
    expect(seek.residualPredicate).toBe("[dbo].[T].[Flag]=(1)");
    expect(seek.warnings).toContain("Residual predicate");
  });

  it("does not treat a hash join ProbeResidual as an actionable access-path residual predicate", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1"><QueryPlan><RelOp NodeId="1" PhysicalOp="Hash Match" LogicalOp="Inner Join"><Hash><HashKeysBuild><ColumnReference Column="Id" /></HashKeysBuild><HashKeysProbe><ColumnReference Column="Id" /></HashKeysProbe><ProbeResidual><ScalarOperator ScalarString="[a].[Id]=[b].[Id]" /></ProbeResidual></Hash></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const operator = parseShowplan(xml, "probe", "probe.sqlplan").statements[0].operators[0];
    expect(operator.residualPredicate).toBeNull();
    expect(operator.warnings).not.toContain("Residual predicate");
  });

  it("marks a leading-wildcard scan as structured non-SARGable evidence", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT Name FROM dbo.T"><QueryPlan><RelOp NodeId="1" PhysicalOp="Index Scan" LogicalOp="Index Scan"><IndexScan><Predicate><ScalarOperator ScalarString="[dbo].[T].[Name] like '%abc'" /></Predicate></IndexScan></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const operator = parseShowplan(xml, "source", "wildcard.sqlplan").statements[0].operators[0];
    expect(operator.residualPredicate).toBeNull();
    expect(operator.nonSargablePredicate).toBe("[dbo].[T].[Name] like '%abc'");
  });

  it("recognizes an N-prefixed Unicode leading-wildcard scan", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT Name FROM dbo.T"><QueryPlan><RelOp NodeId="1" PhysicalOp="Index Scan" LogicalOp="Index Scan"><IndexScan><Predicate><ScalarOperator ScalarString="[dbo].[T].[Name] like N'%abc'" /></Predicate></IndexScan></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const operator = parseShowplan(xml, "source", "unicode-wildcard.sqlplan").statements[0].operators[0];
    expect(operator.nonSargablePredicate).toBe("[dbo].[T].[Name] like N'%abc'");
  });
});
