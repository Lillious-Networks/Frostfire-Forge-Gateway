---
title: Testing
description: The two checks that guard every commit (bun check and bun test), the Husky pre-commit hook, and how the tests replace the database and caches with mocks.
order: 200
---

Two checks run before every commit: the type checker and the unit tests. Neither needs a database, the gateway or the asset server. This page shows how to run them, what they enforce, and how to write a test in the style of the existing ones.

## The two checks

```bash title="Run everything the pre-commit hook runs"
bun check
bun test
```

| Check | Command | Looks at | Fails on |
|-------|---------|----------|----------|
| Types | `bun check` | The whole project, settings from `tsconfig.json` | A type error, an unused variable or parameter, a `switch` fall through |
| Tests | `bun test` | `src/tests/*.test.ts` | A failed expectation |

`bun check` is Bun's own type checker. It reports the same errors as the TypeScript compiler and replaced both ESLint and `tsc` here. To check only some files and what they import, name them: `bun check src/systems/vendors.ts`.

:::note No build step
The engine runs TypeScript directly under Bun. Types are only checked: `noEmit` is set, so nothing is ever written.
:::

## The pre-commit hook

The repository uses Husky. The hook file runs the two checks in order and stops the commit at the first one that fails:

```bash title=".husky/pre-commit"
echo "Running checks..."
bun check
echo "Running Unit Tests..."
bun test
```

:::tip If the hook does not run on your clone
`husky` is a dev dependency, but `package.json` has no `prepare` script that activates it during `bun install`. If your commits skip the checks, run `bunx husky` once in the repository. It points Git at the `.husky` folder.
:::

Running the same two commands by hand before you commit saves a failed commit.

There is no linter. `any` is allowed, and what a linter would usually catch that matters here, such as an unused variable, is an error of the type check (next section).

## Type checking

`tsconfig.json` is strict. The flags that most often stop a commit:

| Flag | Effect |
|------|--------|
| `strict`, `strictNullChecks` | `null` and `undefined` must be handled |
| `noUnusedLocals` | An unused local variable or import is an error |
| `noUnusedParameters` | An unused function parameter is an error |
| `noFallthroughCasesInSwitch` | A `case` must end with `break`, `return` or `throw` |
| `noEmit` | Nothing is written to disk |

```ts title="Unused parameters"
// Error: 'mapName' is declared but its value is never read.
function sync(leaderId: string, mapName: string) { return leaderId; }

// Fine: a leading underscore marks a parameter as unused on purpose
function sync(leaderId: string, _mapName: string) { return leaderId; }
```

Two more things from `tsconfig.json` that matter when you write code:

- The path alias `@engine/*` maps to `./src/*`, so `import log from "@engine/modules/logger"` works from anywhere.
- Shared types such as `Item`, `SpellData`, `WeatherData`, `EngineAPI` and `PluginManifest` are global. They live in `types.d.ts` in the repository root and need no import.

## Running tests

Tests use Bun's built in test runner. They live in `src/tests/` and are named `<something>.test.ts`.

```bash title="Running tests"
# Everything
bun test

# One file
bun test src/tests/spells.test.ts

# Only tests whose name matches
bun test --test-name-pattern "whitelist"
```

Tests do not connect to a real database or asset server. Anything that would reach one is replaced by a mock.

:::warning Do not import the server in a test
`src/socket/server.ts` and `src/socket/receiver.ts` start the server when they are imported (they open listeners, start worker pools and load assets). A test imports the system it checks, for example `src/systems/lootTable.ts` or `src/services/whitelist.ts`, never those two files.
:::

## How tests are written

The existing tests follow three patterns. Pick the lightest one that fits.

### 1. Pure functions

If the code under test needs nothing from outside, import it and call it:

```ts title="src/tests/stun.test.ts"
import { expect, test, describe } from "bun:test";
import { isStunned } from "../systems/spelleffects";

describe("isStunned", () => {
  test("true while the stun timestamp is in the future", () => {
    expect(isStunned({ stunnedUntil: 2000 }, 1000)).toBe(true);
  });

  test("false once the stun timestamp has passed", () => {
    expect(isStunned({ stunnedUntil: 1000 }, 1000)).toBe(false);
    expect(isStunned({ stunnedUntil: 999 }, 1000)).toBe(false);
  });
});
```

### 2. Helpers from setup.ts

`src/tests/setup.ts` exports ready made stand-ins and factories. A test imports what it needs. Nothing is loaded automatically.

| Export | What it is |
|--------|-----------|
| `mockQuery(sql, params)` | A `query` that always resolves to an empty array |
| `databaseModule({ default })` | Wraps the fake you hand to `mock.module("../controllers/sqldatabase", ...)` and adds the layer's other exports. Its `transaction` hands each statement to your `default` in order and undoes nothing, so give it a `transaction` of your own when a test is about a write that fails part way. |
| `standInFor(path, standIn)` | Puts a stand-in in place of one of the engine's own modules while the test file runs, and the real module back when the file is done. See "Stand-ins outlive the file" below. |
| `mockAssetCache` | `get`, `set`, `add` and `getNested`. `get` returns a small fixed data set for `items`, `spells`, `mounts`, `quests`, `weather`, `worlds`, `mapProperties`, `particles`, `npcs` and `audio`. |
| `mockPlayerCache` | `get`, `set`, `has` and `delete`. `get` returns a level 1 player named `test_player`. |
| `mockLog` | A logger that writes to the console |
| `createMockQueryResult(data, affectedRows, lastInsertRowid)` | An object shaped like a database result |
| `createMockCurrency(copper, silver, gold)` | A currency object |
| `createMockItem(overrides)` | An item with sensible defaults |
| `createMockCollectable(overrides)` | A collectable row |

Tests of this kind define the logic they check next to a small in-memory "database":

```ts title="src/tests/currency.test.ts (shortened)"
import { expect, test } from "bun:test";
import { createMockCurrency, createMockQueryResult } from "./setup";

const currencyDatabase: Record<string, any> = {
  test_user: createMockCurrency(50, 30, 100),
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT copper, silver, gold")) {
    const user = params[0];
    return currencyDatabase[user] ? [currencyDatabase[user]] : [];
  }
  if (sql.includes("INSERT INTO currency")) {
    const [username, copper, silver, gold] = params;
    currencyDatabase[username] = { copper, silver, gold };
    return createMockQueryResult();
  }
  return [];
};
```

### 3. Replacing modules with mock.module

To test a real system module, replace what it imports before you import it. `mock.module` swaps the database (and, where needed, the asset cache) for a fake, and the system then runs its real code against that fake.

```ts title="src/tests/loottable.test.ts (shortened)"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// Rows the mocked database returns for loot_table_items, and what was written.
let tableItems: any[] = [];
let written: any[][] = [];

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    if (sql.startsWith("SELECT * FROM loot_tables")) return [{ id: 1, name: "Wolf drops", created_at: null }];
    if (sql.startsWith("SELECT * FROM loot_table_items")) return tableItems;
    if (sql.startsWith("INSERT INTO loot_table_items") || sql.startsWith("UPDATE loot_table_items")) written.push(params);
    return [];
  },
}));
mock.module("../services/assetCache", () => ({
  default: { get: async () => [{ name: "Wolf Pelt", quality: "common" }] },
}));

const { clearCaches } = await import("../services/datacache");
const { default: lootTable, normalizeDropChance } = await import("../systems/lootTable");

// Each test gives the database other rows: the tables held of the last one are forgotten.
beforeEach(clearCaches);

afterEach(() => {
  tableItems = [];
  written = [];
  mock.restore();
});

describe("drop chance", () => {
  test("a 0% drop never rolls, even on the luckiest roll", async () => {
    tableItems = [{ id: 1, loot_table_id: 1, item_name: "Wolf Pelt", min_quantity: 1, max_quantity: 1, drop_chance: "0.00", quality: "common" }];
    const random = spyOn(Math, "random").mockReturnValue(0);
    expect(await lootTable.roll(1)).toEqual([]);
    random.mockRestore();
  });
});
```

Four habits from the existing tests are worth copying:

| Habit | Why |
|-------|-----|
| Call `mock.module` first, then load the system with `await import(...)` | A normal `import` at the top of the file would load the real database module before the mock is in place |
| Call `clearCaches()` from `src/services/datacache` in `beforeEach` | Systems keep copies of rows (see [Caching](#/engine/caching)). Without it, one test reads the rows of the previous one. |
| Make the fake database throw on a statement it does not expect | A read that should have come from a cache then fails the test |
| Restore what you change (`mock.restore()`, `spy.mockRestore()`, environment variables) | Test files share one process |

### Stand-ins outlive the file

`mock.module` is not undone when a test file ends, and `mock.restore()` does not undo it either. A stand-in left in place is what every file that runs afterwards is given instead of the module.

Which files run afterwards is not the same on every machine. On Windows the test files run in name order. On a Linux runner (the release pipeline) they run in the order the filesystem lists them, which changes when a file is added. So a leftover stand-in can pass on your machine and fail in the pipeline.

Two rules keep a file independent of the others:

| What the file replaces | How |
|------------------------|-----|
| The database layer or the asset cache | `mock.module` at the top of the file, as above. Every file that loads a system sets its own, so nothing is inherited. |
| Any other engine module (a system, `playermanager`, `spriteSheetManager`) | `await standInFor(path, () => ({ ... }))`. It loads the real module, puts your stand-in in its place, and puts the real one back in an `afterAll`. |

```ts title="Replacing a system for one file"
import { databaseModule, standInFor } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

await standInFor("../systems/inventory", () => ({
  default: { get: async () => [], add: async () => ({ affectedRows: 1 }) },
}));

const rewards = await import("../systems/quests/rewards");
```

### Generated config files

`src/config/settings.json` and `src/config/aoi.json` are generated when the server starts and are not checked in, so the pipeline has none. Several engine modules import them. `src/tests/preload.ts` (loaded through `bunfig.toml` before any test file) puts the same small stand-ins in place for every file, on every machine. A test never reads your real config, and you do not need to mock these two files yourself.

## An example test

This is a complete test file for the weather conversion in `src/systems/weatherapi.ts`. It follows the third pattern: the database is replaced by a fake that fails on any use, because the real weather must never touch the database.

```ts title="src/tests/my-weather.test.ts"
import { describe, expect, mock, test } from "bun:test";

// The real weather is held in memory: nothing here may ask the database.
mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string) => {
    throw new Error(`The real weather asked the database: ${sql}`);
  },
}));

const api = await import("../systems/weatherapi");

/** A reading of OpenWeatherMap, in imperial units. */
const reading = (over: Record<string, any> = {}) => ({
  weather: [{ id: 501 }],
  main: { temp: 77.6, humidity: 64 },
  wind: { speed: 4.2, deg: 270 },
  rain: { "1h": 3.16 },
  clouds: { all: 100 },
  ...over,
});

describe("readingToWeather", () => {
  test("moderate rain is shown as rainy", () => {
    const result = api.readingToWeather(reading());
    expect(result?.look).toBe("rainy");
    expect(result?.row.name).toBe("weather_api");
    expect(result?.row.temperature).toBe(78);
    expect(result?.row.humidity).toBe(64);
  });

  test("a west wind blows to the right", () => {
    expect(api.readingToWeather(reading())?.row.wind_direction).toBe("right");
  });

  test("a thunderstorm darkens the scene", () => {
    const result = api.readingToWeather(reading({ weather: [{ id: 211 }] }));
    expect(result?.look).toBe("thunderstorm");
    expect(result?.row.ambience).toBe(0.8);
  });

  test("a dry sky has no precipitation", () => {
    const result = api.readingToWeather(reading({ weather: [{ id: 800 }], rain: undefined }));
    expect(result?.look).toBe("clear");
    expect(result?.row.precipitation).toBe(0);
  });

  test("a body without a temperature is not a reading", () => {
    expect(api.readingToWeather({})).toBeNull();
  });

  test("a place is turned into a query", () => {
    expect(api.locationQuery("47.61,-122.33")).toBe("lat=47.61&lon=-122.33");
    expect(api.locationQuery("Seattle,US")).toBe("q=Seattle%2CUS");
    expect(api.locationQuery("")).toBeNull();
  });
});
```

```bash title="Run it"
bun test src/tests/my-weather.test.ts
```

## What is covered

`src/tests/` holds one file per area. A few examples of what you will find there:

| Area | Files |
|------|-------|
| Transport and packets | `transport.test.ts`, `packets.test.ts`, `movement_batch.test.ts`, `wt_close.test.ts`, `local_cert.test.ts` |
| Caches and the database layer | `datacache.test.ts`, `player-cache.test.ts`, `belongings-cache.test.ts`, `sqlescape.test.ts` |
| Login and sessions | `duplicate_login_kick.test.ts`, `simultaneous_login.test.ts`, `disconnect-events.test.ts` |
| Gameplay systems | `spells.test.ts`, `inventory.test.ts`, `parties.test.ts`, `guilds.test.ts`, `quests.test.ts`, `currency.test.ts` |
| Creatures | `creature-combat.test.ts`, `creature-navgrid.test.ts`, `creature-spawner.test.ts` |
| Editors and admin tools | `spell-editor.test.ts`, `weather-editor.test.ts`, `control-panel.test.ts`, `admin-commands.test.ts` |
| Weather and whitelist | `weather.test.ts`, `weather-api.test.ts`, `whitelist.test.ts` |

When you change a system, run its test file first, then the full `bun test`, then the other two checks.

For measuring performance under load, which unit tests do not cover, see [Benchmarking](#/engine/benchmarking).
