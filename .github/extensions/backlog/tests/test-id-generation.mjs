import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { generateId, addItem } from "../items.mjs";

// ID generation must:
//  - lowercase + slugify
//  - drop punctuation
//  - clamp to 50 chars
//  - dedupe with a numeric suffix when the base collides

const a = generateId("Hello, World!");
assertEqual(a, "hello-world", "slugifies basic input");

addItem("test-session", "Hello, World!"); // claims "hello-world"

const b = generateId("Hello, World!");
assertEqual(b, "hello-world-2", "appends -2 on first collision");

addItem("test-session", "Hello, World!"); // claims "hello-world-2"

const c = generateId("Hello, World!");
assertEqual(c, "hello-world-3", "appends -3 on second collision");

const d = generateId("a".repeat(100));
assert(d.length <= 50, "clamps long ids to 50 chars");

done("test-id-generation");
