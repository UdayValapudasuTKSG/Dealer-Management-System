---
name: Date-only fields shift a day in UTC-4
description: Parsing date-only API values as ISO instants moves them to yesterday for Guyana users
---

Date-only columns (e.g. service `scheduledDate`) are serialized by the API as `YYYY-MM-DDT00:00:00.000Z`. Parsing that full string client-side treats it as a UTC instant, so in Guyana (UTC-4) "today" becomes yesterday 8 PM and today-filters silently exclude the row.

**Why:** Postgres `date` columns carry no timezone; the JSON layer fabricates a UTC midnight.

**How to apply:** For any date-only field used in day-based UI logic, parse only the date part as a local date (`parseISO(value.slice(0, 10))`) instead of the full ISO string. Display such items as "All day" rather than a fabricated midnight time.
