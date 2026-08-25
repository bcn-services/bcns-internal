/**
 * leads-import.test.mjs — the sheet -> accounts mapping.
 *
 * No network, no database, no Google. lib/leads-import.ts is pure so the rules
 * that matter (blank is not zero, money never touches a float, an ambiguous
 * date is refused) can be checked at the boundary where they are decided.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toAccount, toAccounts, toCents, STATUSES } from "../lib/leads-import.ts";

const isImportError = (e) => e.name === "LeadImportError";

/** A minimally valid row: the two columns the importer actually requires. */
const base = (over = {}) => ({ place_id: "P1", business_name: "Acme Plumbing", ...over });

describe("required identity", () => {
  test("a row with no place_id is rejected, not defaulted", () => {
    assert.throws(() => toAccount({ business_name: "Acme" }), isImportError);
  });

  test("a row with no business_name is rejected", () => {
    assert.throws(() => toAccount({ place_id: "P1" }), isImportError);
  });

  test("the error names the business, so it is findable in the sheet", () => {
    try {
      toAccount(base({ rating: "9" }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.match(e.message, /Acme Plumbing/);
      assert.match(e.message, /P1/);
    }
  });
});

describe("blank cells", () => {
  test("every optional column of an empty row lands as null, never as \"\"", () => {
    const a = toAccount(base());
    for (const col of ["business_type", "city", "phone", "website", "rating",
      "review_count", "lead_score", "score_reason", "last_contact", "contact_name",
      "last_outcome", "consult_date", "close_date", "deal_value_cents",
      "source_query", "date_added", "notes", "has_website"]) {
      assert.equal(a[col], null, `${col} should be null when the cell is blank`);
    }
  });

  test("whitespace is a blank cell, not a value", () => {
    assert.equal(toAccount(base({ city: "   " })).city, null);
  });

  test("call_count is NOT NULL in the schema, so blank means 0", () => {
    assert.equal(toAccount(base()).call_count, 0);
  });

  test("a blank status means 'new' — the sheet's own default for a fresh lead", () => {
    assert.equal(toAccount(base()).status, "new");
  });

  test("review_count 0 survives as 0 and is not confused with blank", () => {
    assert.equal(toAccount(base({ review_count: "0" })).review_count, 0);
  });
});

describe("column rename", () => {
  test("the sheet's `type` becomes `business_type`", () => {
    const a = toAccount(base({ type: "Plumber" }));
    assert.equal(a.business_type, "Plumber");
    assert.ok(!("type" in a), "the SQL-awkward name must not reach the database");
  });
});

describe("money", () => {
  test("whole dollars", () => assert.equal(toCents("1200"), 120000));
  test("a currency symbol and separators are stripped", () => assert.equal(toCents("$1,200.00"), 120000));
  test("one decimal place is tenths, not hundredths", () => assert.equal(toCents("12.5"), 1250));

  test("the classic float case is exact", () => {
    // Math.round(12.55 * 100) is where cents go wrong. Parsing the digits cannot.
    assert.equal(toCents("12.55"), 1255);
    assert.equal(toCents("0.07"), 7);
  });

  test("blank is null, not zero — an unrecorded deal is not a $0 deal", () => {
    assert.equal(toCents(""), null);
    assert.equal(toCents("   "), null);
  });

  test("a negative or non-numeric amount is refused", () => {
    assert.throws(() => toCents("-5"), isImportError);
    assert.throws(() => toCents("about 1200"), isImportError);
    assert.throws(() => toCents("1.234"), isImportError);
  });
});

describe("dates", () => {
  test("an ISO day passes through unchanged", () => {
    assert.equal(toAccount(base({ date_added: "2026-07-30" })).date_added, "2026-07-30");
  });

  test("an ambiguous format is refused rather than guessed", () => {
    // 8/9/26 is August 9th in one country and September 8th in another.
    assert.throws(() => toAccount(base({ close_date: "8/9/26" })), isImportError);
  });

  test("a well-formed but unreal date is refused", () => {
    assert.throws(() => toAccount(base({ close_date: "2026-02-30" })), isImportError);
  });
});

describe("constrained values", () => {
  test("every status the sheet allows is accepted by the importer", () => {
    // If sheets.py's STATUSES and the schema CHECK ever diverge, this fails.
    for (const s of STATUSES) assert.equal(toAccount(base({ status: s })).status, s);
  });

  test("status is case-insensitive but not free text", () => {
    assert.equal(toAccount(base({ status: "WON" })).status, "won");
    assert.throws(() => toAccount(base({ status: "maybe" })), isImportError);
  });

  test("rating is bounded by the schema's 0..5", () => {
    assert.equal(toAccount(base({ rating: "4.9" })).rating, 4.9);
    assert.throws(() => toAccount(base({ rating: "9" })), isImportError);
  });

  test("lead_score is bounded by the schema's 0..100", () => {
    assert.equal(toAccount(base({ lead_score: "80" })).lead_score, 80);
    assert.throws(() => toAccount(base({ lead_score: "120" })), isImportError);
  });

  test("a fractional count is refused, not truncated", () => {
    assert.throws(() => toAccount(base({ review_count: "3.7" })), isImportError);
  });

  test("has_website accepts the spellings a human types, and refuses the rest", () => {
    assert.equal(toAccount(base({ has_website: "yes" })).has_website, true);
    assert.equal(toAccount(base({ has_website: "NO" })).has_website, false);
    // A typo must not read as false: that silently reclassifies a lead.
    assert.throws(() => toAccount(base({ has_website: "ys" })), isImportError);
  });
});

describe("the batch", () => {
  test("every bad row is reported, not just the first", () => {
    const { rows, errors } = toAccounts([
      base({ place_id: "A" }),
      base({ place_id: "B", rating: "9" }),
      base({ place_id: "C", close_date: "nope" }),
      base({ place_id: "D" }),
    ]);
    assert.equal(rows.length, 2);
    assert.equal(errors.length, 2, "one run should surface both bad cells");
  });

  test("a duplicate place_id is reported instead of letting row order decide", () => {
    const { rows, errors } = toAccounts([
      base({ place_id: "A", business_name: "First" }),
      base({ place_id: "A", business_name: "Second" }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].business_name, "First");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /duplicate place_id/);
  });

  test("an empty sheet is not an error", () => {
    assert.deepEqual(toAccounts([]), { rows: [], errors: [] });
  });
});
