import { describe, expect, it } from "vite-plus/test";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Column from "../src/Column.ts";

const at = DateTime.makeUnsafe("2026-11-12T03:04:05.678Z");
const Line = Schema.Struct({ quantity: Decimal.Decimal, at: Schema.DateTimeUtcFromString });

describe("Column.timestamp", () => {
  it.each(["sqlite", "d1"] as const)("is ISO text on %s", (dialect) => {
    const codec = Column.timestamp(dialect);
    expect(Schema.encodeSync(codec)(at)).toBe("2026-11-12T03:04:05.678Z");
    expect(Schema.decodeSync(codec)("2026-11-12T03:04:05.678Z")).toStrictEqual(at);
  });

  it("is a Date on Postgres, which the client binds as timestamptz", () => {
    const codec = Column.timestamp("postgres");
    const date = DateTime.toDateUtc(at);
    expect(Schema.encodeSync(codec)(at)).toStrictEqual(date);
    expect(Schema.decodeSync(codec)(date)).toStrictEqual(at);
  });

  it("refuses an invalid instant", () => {
    expect(Exit.isFailure(Schema.decodeExit(Column.timestamp("sqlite"))("yesterday"))).toBe(true);
    // The Postgres client returns a `timestamptz` as a `Date`, never text.
    expect(
      Exit.isFailure(Schema.decodeExit(Column.timestamp("postgres"))("2026-11-12T03:04:05.678Z")),
    ).toBe(true);
  });
});

describe("Column.json", () => {
  it("is JSON text on SQLite and D1, through the schema's JSON encoding", () => {
    const codec = Column.json("sqlite", Line);
    const text = '{"quantity":"1.5","at":"2026-11-12T03:04:05.678Z"}';
    expect(Schema.encodeSync(codec)({ quantity: Decimal.make("1.5"), at })).toBe(text);
    expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(text))).toBe(text);
  });

  it("reads parsed jsonb and writes JSON text on Postgres", () => {
    const codec = Column.json("postgres", Line);
    const decoded = Schema.decodeSync(codec)({
      quantity: "1.5",
      at: "2026-11-12T03:04:05.678Z",
    });
    expect(Schema.encodeSync(codec)(decoded)).toBe(
      '{"quantity":"1.5","at":"2026-11-12T03:04:05.678Z"}',
    );
  });

  it("keeps a JSON string a string on Postgres", () => {
    const codec = Column.json("postgres", Schema.String);
    expect(Schema.decodeSync(codec)("hello")).toBe("hello");
    expect(Schema.encodeSync(codec)("hello")).toBe('"hello"');
  });

  it("refuses a value the schema refuses", () => {
    expect(Exit.isFailure(Schema.decodeExit(Column.json("postgres", Line))({}))).toBe(true);
    expect(Exit.isFailure(Schema.decodeExit(Column.json("sqlite", Line))("{"))).toBe(true);
  });
});

describe("Column.decimal", () => {
  it("is core's canonical decimal text on every dialect", () => {
    expect(Schema.encodeSync(Column.decimal)(Decimal.make("0.00000000000000000001"))).toBe(
      "0.00000000000000000001",
    );
    expect(Exit.isFailure(Schema.decodeExit(Column.decimal)("NaN"))).toBe(true);
    expect(Exit.isFailure(Schema.decodeUnknownExit(Column.decimal)(1.5))).toBe(true);
  });
});

describe("Column.id and Column.nullable", () => {
  it("brands ids and maps None to NULL", () => {
    const PartyId = Column.id("PartyId");
    const codec = Column.nullable(PartyId);
    expect(Schema.decodeSync(codec)(null)).toStrictEqual(Option.none());
    expect(Schema.encodeSync(codec)(Option.none())).toBeNull();
    expect(Exit.isFailure(Schema.decodeExit(PartyId)("not-an-id"))).toBe(true);
  });
});

describe("Column.make", () => {
  it("gathers one dialect's codecs", () => {
    const columns = Column.make("postgres");
    expect(columns.dialect).toBe("postgres");
    expect(Schema.encodeSync(columns.timestamp)(at)).toStrictEqual(DateTime.toDateUtc(at));
    expect(Schema.encodeSync(columns.json(Schema.Array(Schema.String)))(["a"])).toBe('["a"]');
  });
});
