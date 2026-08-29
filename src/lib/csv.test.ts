import { describe, expect, it } from "vitest";
import { detectDelimiter, findHeaderRow, parseCsv } from "./csv";

describe("CSV ingestion", () => {
  it("handles quoted delimiters, escaped quotes, and multiline XML", () => {
    const text = 'note,session_id,wait_info,query_plan\r\n"hello, world",51,"(1200ms)LCK_M_X","<ShowPlanXML>\n<x a=""1""/></ShowPlanXML>"';
    const rows = parseCsv(text);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("hello, world");
    expect(rows[1][3]).toContain("\n<x a=\"1\"/>");
    expect(findHeaderRow(rows)).toBe(0);
  });

  it("detects tab and semicolon exports", () => {
    expect(detectDelimiter("session_id\twait_info\n51\tNULL")).toBe("\t");
    expect(detectDelimiter("session_id;wait_info\n51;NULL")).toBe(";");
  });
});
