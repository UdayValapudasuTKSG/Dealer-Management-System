import assert from "node:assert/strict";
import {
  renderEmail,
  serializeServiceSummaryRows,
  TEMPLATE_DEFS,
} from "../lib/email";

const preview = renderEmail(
  "service.summary.management",
  TEMPLATE_DEFS["service.summary.management"].sample,
);
assert.match(preview.html, /<strong>Aug 12<\/strong>/);
assert.match(preview.html, /Alex Mensah\)<br\/><strong>Aug 13<\/strong>/);
assert.doesNotMatch(preview.html, /&lt;strong&gt;Aug 12/);
assert.doesNotMatch(preview.html, /&lt;br\/&gt;/);

const live = renderEmail("service.summary.management", {
  count: "1",
  window: "over the next 3 days",
  rows: serializeServiceSummaryRows([
    {
      date: "Aug <12>",
      vehicle: `<img src=x onerror="alert(1)">`,
      type: "repair & inspection",
      customerName: "<script>alert(1)</script>",
      technician: "Tech <One>",
    },
  ]),
});
assert.match(live.html, /<strong>Aug &lt;12&gt;<\/strong>/);
assert.match(live.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.match(live.html, /repair &amp; inspection/);
assert.match(live.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(live.html, /Tech &lt;One&gt;/);
assert.doesNotMatch(live.html, /<script>|<img src=x/);

const legacyQueued = renderEmail("service.summary.management", {
  count: "1",
  window: "over the next 3 days",
  rows: "<strong>Aug 12</strong> — Vehicle <unsafe>, repair<br/><strong>Aug 13</strong> — Safe vehicle, inspection",
});
assert.match(
  legacyQueued.html,
  /<strong>Aug 12<\/strong> — Vehicle &lt;unsafe&gt;, repair<br\/><strong>Aug 13<\/strong>/,
);

console.log("Service summary rendering: trusted layout rendered and values escaped");