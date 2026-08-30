// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Finding } from "../types";
import { FindingDrawer } from "./FindingDrawer";

Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => undefined });

afterEach(cleanup);

const finding: Finding = {
  id: "finding-1",
  ruleId: "PLAN-TEST",
  severity: "Medium",
  confidence: "High",
  category: "Execution plan",
  title: "Qualified plan finding",
  summary: "One plan-native finding.",
  explanation: "Context stays advisory.",
  remediation: [],
  evidence: [],
  references: [],
  affectedRecordIds: [],
  affectedPlanIds: ["plan-1", "statement-1"],
  impact: 1,
  qualifications: [{ kind: "Compile memory", disposition: "Context only", value: "4096 KB", reason: "Separate from execution workspace grants.", planId: "plan-1", statementId: "statement-1" }],
};

describe("FindingDrawer compile context", () => {
  it("discloses qualifications without presenting them as a grade change", () => {
    render(<FindingDrawer finding={finding} onClose={() => undefined} />);
    expect(screen.getByText("Compile and optimizer context")).toBeTruthy();
    expect(screen.getByText("Compile memory")).toBeTruthy();
    expect(screen.getByText("4096 KB")).toBeTruthy();
    expect(screen.getByText(/does not change this finding's severity or confidence grade/i)).toBeTruthy();
  });
});
