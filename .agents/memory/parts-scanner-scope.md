---
name: Parts scanner scope
description: Approved Inateck keyboard-scanner behaviour and boundaries.
---
The user approved starting Inateck integration with parts catalogue and Parts POS, with vehicle/shipment scanning deferred.

**Why:** They want scanned codes to autofill existing catalogue details, not to invent product information encoded nowhere in the barcode.

**How to apply:** Support USB/Bluetooth keyboard (HID) input. Match only inside the active dealer. Unknown codes offer creation with the barcode filled in; ambiguous matches require manual selection. A scan may fill a form or change a draft cart, but never submit a sale or change inventory by itself.
