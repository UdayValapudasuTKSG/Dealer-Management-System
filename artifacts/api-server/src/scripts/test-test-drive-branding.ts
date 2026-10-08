import assert from "node:assert/strict";
import { testDriveBranding } from "../lib/test-drive-branding";

const defaults = { brandName: null, themeColor: null, address: "Old address" };
assert.deepEqual(testDriveBranding({ ...defaults, name: "GT Automotive" }), {
  dealerName: "GT Automotive",
  showroomAddress: "220 Camp St, Georgetown",
  brandColor: "#B58A55",
});
assert.equal(testDriveBranding({ ...defaults, name: "CAM MOTORS" }).showroomAddress,
  "5 Vlissengen Road and Dowding Street, Georgetown");
assert.deepEqual(testDriveBranding({
  ...defaults, name: "Other Dealer", brandName: "Other Brand", themeColor: "#123456",
}), {
  dealerName: "Other Brand", showroomAddress: "Old address", brandColor: "#123456",
});
assert.equal(testDriveBranding({
  ...defaults, name: "Other Dealer", themeColor: "invalid",
}).brandColor, "#B58A55");
console.log("Test-drive branding: GT, CAM, other-dealer isolation and colour validation passed.");
