import { expect, test } from "vite-plus/test";
import { name } from "./index.ts";

test("name", () => {
  expect(name).toBe("effect-biz");
});
