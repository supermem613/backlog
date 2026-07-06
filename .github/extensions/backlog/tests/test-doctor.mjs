import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { formatDoctorReport, getRuntimeInfo, runItemDeleteSmoke } from "../doctor.mjs";

const runtime = getRuntimeInfo();
assertEqual(runtime.legacyStoragePresent, false, "doctor reports legacy storage removed");
assert(runtime.extensionPath.endsWith("extension.mjs"), "doctor reports extension entrypoint path");
assert(runtime.packagePath.endsWith("package.json"), "doctor reports package path");

const smoke = runItemDeleteSmoke("test");
assertEqual(smoke.ok, true, "doctor smoke deletes an item");

const report = formatDoctorReport({ ok: true });
assert(/Backlog /.test(report), "doctor report includes version header");
assert(/legacy storage: removed/.test(report), "doctor report includes legacy storage status");
assert(/item delete smoke: ok/.test(report), "doctor report includes smoke status");

done("test-doctor");
