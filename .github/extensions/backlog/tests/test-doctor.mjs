import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { formatDoctorReport, getRuntimeInfo, runFrictionDeleteSmoke } from "../doctor.mjs";

const runtime = getRuntimeInfo();
assertEqual(runtime.itemContextCascade, true, "doctor reports item_contexts cascade enabled");
assert(runtime.extensionPath.endsWith("extension.mjs"), "doctor reports extension entrypoint path");
assert(runtime.packagePath.endsWith("package.json"), "doctor reports package path");

const smoke = runFrictionDeleteSmoke("test");
assertEqual(smoke.ok, true, "doctor smoke deletes friction item and contexts");

const report = formatDoctorReport({ ok: true, contexts: 0 });
assert(/Backlog /.test(report), "doctor report includes version header");
assert(/item_contexts cascade: ok/.test(report), "doctor report includes cascade status");
assert(/friction delete smoke: ok/.test(report), "doctor report includes smoke status");

done("test-doctor");
