import "./harness.mjs";
import { assert, done } from "./harness.mjs";
import { sidecarState, writeLock, readLock } from "../sidecar.mjs";

// Regression guard for "the viewer keeps popping up out of nowhere".
//
// The viewer's open/closed intent (viewerSuppressed when the user closes the
// window, forceOpen when /backlog show is used) lives only in the owner
// process memory. When the owning session ends, a surviving session promotes
// itself to owner via becomeOwner, which inherits only the token from the
// shared lock. The promoted owner therefore starts with viewerSuppressed
// false and reopens the window whenever the backlog has pending items, even
// though the user had deliberately closed it.
//
// The shared lock is the only cross-process handoff channel, so the fix must
// record the visibility intent there. These assertions prove the intent
// survives a lock round-trip. They fail before the fix because writeLock
// drops both flags.

sidecarState.role = "owner";
sidecarState.token = "suppression-handoff-token";

// The user closed the viewer window on the current owner.
sidecarState.viewerSuppressed = true;
sidecarState.forceOpen = false;
writeLock();

const afterClose = readLock();
assert(
  afterClose?.viewerSuppressed === true,
  "shared lock records that the user closed the viewer so a promoted owner stays closed"
);
assert(
  afterClose?.forceOpen === false,
  "shared lock records forceOpen=false after the user closes the viewer"
);

// /backlog show forces the viewer open on the current owner.
sidecarState.viewerSuppressed = false;
sidecarState.forceOpen = true;
writeLock();

const afterShow = readLock();
assert(
  afterShow?.forceOpen === true,
  "shared lock records forceOpen so a promoted owner keeps the viewer open"
);
assert(
  afterShow?.viewerSuppressed === false,
  "shared lock clears suppression once the viewer is forced open"
);

done("test-sidecar-suppression-handoff");
