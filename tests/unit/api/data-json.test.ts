/** The Data panel shows the JSON files starter bots save, as tables. */
import { jsonTable } from "../../../apps/api/src/modules/projects/dataJson.js";

describe("JSON as a table", () => {
  it("wallets by user id: a row per entry with its key", () => {
    const t = jsonTable({ u1: { name: "maya", coins: 5 }, u2: { name: "leo", coins: 9, vip: true } });
    expect(t.columns).toEqual(["key", "name", "coins", "vip"]);
    expect(t.rows).toEqual([["u1", "maya", 5, null], ["u2", "leo", 9, "true"]]);
  });
  it("a list of words is an editable list; trivia pairs get numbered columns", () => {
    expect(jsonTable(["bad", "worse"])).toMatchObject({ kind: "list", columns: ["value"], rows: [["bad"], ["worse"]] });
    expect(jsonTable([["Q?", "A"]])).toMatchObject({ columns: ["1", "2"], rows: [["Q?", "A"]] });
  });
  it("lists of objects and nested values", () => {
    const t = jsonTable([{ a: 1 }, { b: [1, 2] }]);
    expect(t.rows).toEqual([[1, null], [null, "[1,2]"]]);
  });
});
