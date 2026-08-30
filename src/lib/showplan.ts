import { DOMParser } from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";
import type { PlanDocument, PlanOperator, PlanSourceKind, PlanStatement } from "../types";
import { asNumber, makeId } from "./utils";

function elements(parent: XmlElement | XmlDocument, name: string): XmlElement[] {
  return Array.from(parent.getElementsByTagName(name)) as XmlElement[];
}

function elementName(element: XmlElement): string {
  return element.localName || element.tagName.split(":").at(-1) || element.tagName;
}

/** Find descendants owned by one operator without crossing into a nested RelOp. */
function operatorElements(parent: XmlElement, name: string): XmlElement[] {
  const matches: XmlElement[] = [];
  const visit = (element: XmlElement) => {
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType !== 1) continue;
      const child = node as XmlElement;
      const childName = elementName(child);
      if (childName === name) matches.push(child);
      if (childName !== "RelOp") visit(child);
    }
  };
  visit(parent);
  return matches;
}

function attr(element: XmlElement | undefined, name: string): string | null {
  return element?.getAttribute(name) ?? null;
}

function numberAttr(element: XmlElement | undefined, name: string): number | null {
  return asNumber(attr(element, name));
}

function compileNumberAttr(element: XmlElement | undefined, name: string, warnings: string[]): number | null {
  const value = attr(element, name);
  if (value === null) return null;
  const trimmed = value.trim();
  const parsed = trimmed && /^[+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    warnings.push(`${name} was ignored because it was not a finite non-negative number.`);
    return null;
  }
  return parsed;
}

function runtimeRows(relop: XmlElement): number | null {
  const counters = operatorElements(relop, "RunTimeCountersPerThread");
  if (!counters.length) return null;
  const values = counters.map((counter) => numberAttr(counter, "ActualRows") ?? 0);
  return values.reduce((total, value) => total + value, 0);
}

function operatorWarnings(relop: XmlElement): string[] {
  const warnings: string[] = [];
  for (const warning of operatorElements(relop, "Warnings")) {
    if (warning.getAttribute("NoJoinPredicate") === "1") warnings.push("No join predicate");
    if (warning.getAttribute("SpillToTempDb") === "1") warnings.push("Spill to tempdb");
    if (warning.getAttribute("PlanAffectingConvert") === "1") warnings.push("Plan-affecting conversion");
    if (elements(warning, "SpillToTempDb").length || elements(warning, "SortSpillDetails").length || elements(warning, "HashSpillDetails").length) warnings.push("Runtime spill");
    for (const conversion of elements(warning, "PlanAffectingConvert")) {
      const expression = attr(conversion, "Expression");
      warnings.push(expression ? `Plan-affecting conversion: ${expression}` : "Plan-affecting conversion");
    }
  }
  return [...new Set(warnings)];
}

function predicateExpression(element: XmlElement | undefined): string | null {
  if (!element) return null;
  const scalar = operatorElements(element, "ScalarOperator")
    .map((item) => attr(item, "ScalarString") ?? item.textContent ?? "")
    .find((value) => value.trim());
  return scalar?.trim() || element.textContent?.trim() || null;
}

function parseOperators(statement: XmlElement): PlanOperator[] {
  return elements(statement, "RelOp").map((relop) => {
    const object = operatorElements(relop, "Object")[0];
    const ordinaryPredicate = operatorElements(relop, "Predicate")[0];
    const seekPredicates = operatorElements(relop, "SeekPredicates")[0];
    // ProbeResidual is the normal equality verification used by a hash join after
    // probing a hash bucket. It is not an access-path residual predicate.
    const explicitResidual = operatorElements(relop, "Residual")[0];
    const seekPredicate = predicateExpression(seekPredicates);
    const residualPredicate = predicateExpression(explicitResidual ?? (seekPredicates && ordinaryPredicate ? ordinaryPredicate : undefined));
    const predicate = predicateExpression(ordinaryPredicate) ?? residualPredicate ?? seekPredicate;
    const nonSargablePredicate = predicate && /scan/i.test(attr(relop, "PhysicalOp") ?? "")
      && (/\blike\s+N?['"]%/i.test(predicate) || /convert_implicit/i.test(predicate)) ? predicate : null;
    const scalarText = operatorElements(relop, "ScalarOperator").map((item) => attr(item, "ScalarString") ?? item.textContent ?? "").join(" ");
    const hasScalarFunction = operatorElements(relop, "UserDefinedFunction").length > 0 || /\b(?:udf|userdefinedfunction)\b/i.test(scalarText);
    const warnings = operatorWarnings(relop);
    if (residualPredicate) warnings.push("Residual predicate");
    if (hasScalarFunction) warnings.push("Scalar function");
    return {
      id: makeId("op"),
      nodeId: numberAttr(relop, "NodeId"),
      physicalOp: attr(relop, "PhysicalOp") ?? "Unknown",
      logicalOp: attr(relop, "LogicalOp") ?? "Unknown",
      estimatedRows: numberAttr(relop, "EstimateRows"),
      actualRows: runtimeRows(relop),
      estimatedCost: numberAttr(relop, "EstimatedTotalSubtreeCost"),
      warnings: [...new Set(warnings)],
      objectName: object ? [attr(object, "Schema"), attr(object, "Table"), attr(object, "Index")].filter(Boolean).join(".") : undefined,
      predicate,
      seekPredicate,
      residualPredicate,
      nonSargablePredicate,
      isParallel: attr(relop, "Parallel") === "1",
      hasScalarFunction,
    };
  });
}

function attachStatementWarnings(operators: PlanOperator[], warnings: string[]): void {
  for (const warning of warnings) {
    const conversionExpression = warning.match(/^Plan-affecting conversion:\s*(.+)$/i)?.[1]?.toLowerCase().replace(/\s+/g, " ");
    const owner = conversionExpression
      ? operators.find((operator) => operator.predicate?.toLowerCase().replace(/\s+/g, " ").includes(conversionExpression))
      : /spill/i.test(warning)
        ? operators.find((operator) => /sort|hash/i.test(`${operator.physicalOp} ${operator.logicalOp}`))
        : /no join predicate/i.test(warning)
          ? operators.find((operator) => /join/i.test(`${operator.physicalOp} ${operator.logicalOp}`))
          : undefined;
    if (owner) owner.warnings = [...new Set([...owner.warnings, warning])];
  }
}

function parseStatement(statement: XmlElement, documentWarnings: string[]): PlanStatement {
  const queryPlan = elements(statement, "QueryPlan")[0];
  const operators = parseOperators(statement);
  const statementWarnings = queryPlan ? operatorWarnings(queryPlan) : [];
  attachStatementWarnings(operators, statementWarnings);
  const memory = elements(queryPlan ?? statement, "MemoryGrantInfo")[0];
  const missingGroups = elements(statement, "MissingIndexGroup");
  const missingImpact = missingGroups.reduce((maximum, group) => Math.max(maximum, numberAttr(group, "Impact") ?? 0), 0) || null;
  const text = attr(statement, "StatementText") ?? "";
  const isActual = operators.some((operator) => operator.actualRows !== null) || elements(statement, "RunTimeInformation").length > 0;
  const warnings = [...new Set([...statementWarnings, ...operators.flatMap((operator) => operator.warnings)])];
  return {
    id: makeId("stmt"),
    statementText: text,
    statementType: attr(statement, "StatementType") ?? statement.tagName,
    estimatedCost: numberAttr(statement, "StatementSubTreeCost"),
    isActual,
    missingIndexImpact: missingImpact,
    memoryGrant: memory ? {
      requestedKb: numberAttr(memory, "RequestedMemory") ?? 0,
      grantedKb: numberAttr(memory, "GrantedMemory") ?? 0,
      usedKb: numberAttr(memory, "MaxUsedMemory") ?? 0,
    } : undefined,
    operators,
    warnings,
    queryIdentity: {
      sqlHandle: attr(statement, "SqlHandle") ?? attr(statement, "StatementSqlHandle"),
      planHandle: attr(statement, "PlanHandle"),
      queryHash: attr(statement, "QueryHash"),
      queryPlanHash: attr(statement, "QueryPlanHash"),
      statementStartOffset: numberAttr(statement, "StatementStartOffset"),
      statementEndOffset: numberAttr(statement, "StatementEndOffset"),
      queryStoreQueryId: numberAttr(statement, "QueryStoreQueryId"),
      queryStorePlanId: numberAttr(statement, "QueryStorePlanId"),
      databaseId: numberAttr(statement, "DatabaseId"),
    },
    nonParallelPlanReason: attr(queryPlan, "NonParallelPlanReason"),
    earlyAbortReason: attr(statement, "StatementOptmEarlyAbortReason"),
    optimizationLevel: attr(statement, "StatementOptmLevel"),
    degreeOfParallelism: numberAttr(queryPlan, "DegreeOfParallelism"),
    compileTimeMs: compileNumberAttr(queryPlan, "CompileTime", documentWarnings),
    compileCpuMs: compileNumberAttr(queryPlan, "CompileCPU", documentWarnings),
    compileMemoryKb: compileNumberAttr(queryPlan, "CompileMemory", documentWarnings),
    retrievedFromCache: attr(statement, "RetrievedFromCache") === null ? null : attr(statement, "RetrievedFromCache")?.toLowerCase() === "true",
  };
}

function inferSourceKind(fileName: string, actual: boolean, sourceId: string): PlanSourceKind {
  const source = `${fileName} ${sourceId}`.toLowerCase();
  if (source.includes("query-store") || source.includes("querystore")) return "Query Store";
  if (source.includes("last-known") || source.includes("last_query_plan")) return "Last-known actual";
  if (source.includes("extended-event") || source.includes("showplan_xml") || source.includes("xe-")) return "Extended Events";
  if (source.includes("embedded")) return "Embedded";
  return actual ? "Actual" : "Cached estimated";
}

export function parseShowplan(xml: string, sourceId: string, fileName: string): PlanDocument {
  if (/<!DOCTYPE/i.test(xml)) throw new Error("DOCTYPE declarations are not allowed in plan files.");
  const parserErrors: string[] = [];
  const document = new DOMParser({ onError: (level, message) => { if (level === "error" || level === "fatalError") parserErrors.push(message); } }).parseFromString(xml, "application/xml");
  const roots = elements(document, "ShowPlanXML");
  if (!roots.length || parserErrors.length) throw new Error(`This file is not valid SQL Server Showplan XML${parserErrors[0] ? `: ${parserErrors[0]}` : "."}`);
  const planWarnings: string[] = [];
  const statements = ["StmtSimple", "StmtCond", "StmtCursor", "StmtUseDb", "StmtReceive"]
    .flatMap((name) => elements(document, name))
    .map((statement) => parseStatement(statement, planWarnings));
  if (!statements.length) throw new Error("No SQL statements were found in the Showplan document.");
  const root = roots[0];
  return {
    id: makeId("plan"),
    sourceId,
    fileName,
    version: attr(root, "Version"),
    isActual: statements.some((statement) => statement.isActual),
    statements,
    warnings: [...new Set(planWarnings)],
    sourceKind: inferSourceKind(fileName, statements.some((statement) => statement.isActual), sourceId),
    capturedAt: null,
  };
}
