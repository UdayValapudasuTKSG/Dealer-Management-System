# WhatsApp service appointment template setup

The service booking **Remind** action uses the server-owned, dealer-scoped
Meta WhatsApp utility template `service_appointment_confirmed`. It is sent
only after the booking has status `acknowledged` (confirmed), and only from an
explicit staff click. Confirming a booking does not send a WhatsApp message or
an email.

## Meta approval requirements

Create and approve this template in each dealership's WhatsApp Business
Account before deploying the feature:

- **Name:** `service_appointment_confirmed`
- **Category:** Utility
- **Language:** English (`en`)
- **Header:** `Service Appointment Confirmed` (static text; no header variable)
- **Body (exact copy):**

  ```text
  Hi {{1}}, your service appointment at {{2}} is confirmed.

  Booking reference: {{3}}
  Service: {{4}}
  Date: {{5}}
  Time: {{6}}
  Vehicle: {{7}}
  Registration: {{8}}

  Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.

  Thank you. We look forward to welcoming you for your vehicle care.
  ```

The body must have exactly eight text variables in this order:

1. Customer name
2. Dealership name
3. Booking reference (`RO-` plus the persisted service-order id)
4. Persisted service type
5. Appointment date formatted in the dealership's saved IANA timezone
6. Appointment time formatted in the dealership's saved IANA timezone
7. Persisted vehicle description
8. Persisted registration number (or the truthful `Not recorded` value when
   the booking has no registration)

The dealership name is used for `{{2}}`. Do not add punctuation, variables, a
footer, buttons, or a dynamic header to the approved template. Meta template
names and languages are case-sensitive.

## Channel configuration

Each dealership must have its own enabled WhatsApp channel with a valid
WABA/phone-number ID and encrypted access token. The application resolves the
channel by the active dealership and never falls back to another dealership's
sender. The existing generic outside-24-hour service template setting remains
for other WhatsApp flows; this appointment action always uses the exact
template above.

No SMTP credentials or customer email address are required for this action.
Phone opt-out (`STOP`), reviewed-import suppression, dealer scoping, outbox
deduplication, retries, provider receipts, and terminal error reporting are
applied by the existing WhatsApp outbox pipeline. A queued row is not reported
as sent; the UI reports `queued` until the provider accepts it.

## Safe verification and rollout

Do not submit the template for approval, mutate production channel settings,
or send a real customer message as part of code verification. Use a mock Graph
transport (`WHATSAPP_GRAPH_BASE_URL`) and disable the worker when testing
enqueue behavior. The focused transport test is:

```sh
pnpm --filter @workspace/api-server test:service-appointment-whatsapp
```

Before enabling a dealer, verify the approved template in Meta and perform a
non-customer mock send that confirms the request contains a template body
component with exactly eight ordered text parameters, language `en`, and name
`service_appointment_confirmed`.# WhatsApp service appointment template setup

The service booking **Remind** action uses the server-owned, dealer-scoped
Meta WhatsApp utility template `service_appointment_confirmed`. It is sent
only after the booking has status `acknowledged` (confirmed), and only from an
explicit staff click. Confirming a booking does not send a WhatsApp message or
an email.

## Meta approval requirements

Create and approve this template in each dealership's WhatsApp Business
Account before deploying the feature:

- **Name:** `service_appointment_confirmed`
- **Category:** Utility
- **Language:** English (`en`)
- **Header:** `Service Appointment Confirmed` (static text; no header variable)
- **Body (exact copy):**

  ```text
  Hi {{1}}, your service appointment at {{2}} is confirmed.

  Booking reference: {{3}}
  Service: {{4}}
  Date: {{5}}
  Time: {{6}}
  Vehicle: {{7}}
  Registration: {{8}}

  Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.

  Thank you. We look forward to welcoming you for your vehicle care.
  ```

The body must have exactly eight text variables in this order:

1. Customer name
2. Dealership name
3. Booking reference (`RO-` plus the persisted service-order id)
4. Persisted service type
5. Appointment date formatted in the dealership's saved IANA timezone
6. Appointment time formatted in the dealership's saved IANA timezone
7. Persisted vehicle description
8. Persisted registration number (or the truthful `Not recorded` value when
   the booking has no registration)

The dealership name is used for `{{2}}`. Do not add punctuation, variables, a
footer, buttons, or a dynamic header to the approved template. Meta template
names and languages are case-sensitive.

## Channel configuration

Each dealership must have its own enabled WhatsApp channel with a valid
WABA/phone-number ID and encrypted access token. The application resolves the
channel by the active dealership and never falls back to another dealership's
sender. The existing generic outside-24-hour service template setting remains
for other WhatsApp flows; this appointment action always uses the exact
template above.

No SMTP credentials or customer email address are required for this action.
Phone opt-out (`STOP`), reviewed-import suppression, dealer scoping, outbox
deduplication, retries, provider receipts, and terminal error reporting are
applied by the existing WhatsApp outbox pipeline. A queued row is not reported
as sent; the UI reports `queued` until the provider accepts it.

## Safe verification and rollout

Do not submit the template for approval, mutate production channel settings,
or send a real customer message as part of code verification. Use a mock Graph
transport (`WHATSAPP_GRAPH_BASE_URL`) and disable the worker when testing
enqueue behavior. The focused transport test is:

```sh
pnpm --filter @workspace/api-server test:service-appointment-whatsapp
```

Before enabling a dealer, verify the approved template in Meta and perform a
non-customer mock send that confirms the request contains a template body
component with exactly eight ordered text parameters, language `en`, and name
`service_appointment_confirmed`.# WhatsApp service appointment template setup

The service booking **Remind** action uses the server-owned, dealer-scoped
Meta WhatsApp utility template `service_appointment_confirmed`. It is sent
only after the booking has status `acknowledged` (confirmed), and only from an
explicit staff click. Confirming a booking does not send a WhatsApp message or
an email.

## Meta approval requirements

Create and approve this template in each dealership's WhatsApp Business
Account before deploying the feature:

- **Name:** `service_appointment_confirmed`
- **Category:** Utility
- **Language:** English (`en`)
- **Header:** `Service Appointment Confirmed` (static text; no header variable)
- **Body (exact copy):**

  ```text
  Hi {{1}}, your service appointment at {{2}} is confirmed.

  Booking reference: {{3}}
  Service: {{4}}
  Date: {{5}}
  Time: {{6}}
  Vehicle: {{7}}
  Registration: {{8}}

  Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.

  Thank you. We look forward to welcoming you for your vehicle care.
  ```

The body must have exactly eight text variables in this order:

1. Customer name
2. Dealership name
3. Booking reference (`RO-` plus the persisted service-order id)
4. Persisted service type
5. Appointment date formatted in the dealership's saved IANA timezone
6. Appointment time formatted in the dealership's saved IANA timezone
7. Persisted vehicle description
8. Persisted registration number (or the truthful `Not recorded` value when
   the booking has no registration)

The dealership name is used for `{{2}}`. Do not add punctuation, variables, a
footer, buttons, or a dynamic header to the approved template. Meta template
names and languages are case-sensitive.

## Channel configuration

Each dealership must have its own enabled WhatsApp channel with a valid
WABA/phone-number ID and encrypted access token. The application resolves the
channel by the active dealership and never falls back to another dealership's
sender. The existing generic outside-24-hour service template setting remains
for other WhatsApp flows; this appointment action always uses the exact
template above.

No SMTP credentials or customer email address are required for this action.
Phone opt-out (`STOP`), reviewed-import suppression, dealer scoping, outbox
deduplication, retries, provider receipts, and terminal error reporting are
applied by the existing WhatsApp outbox pipeline. A queued row is not reported
as sent; the UI reports `queued` until the provider accepts it.

## Safe verification and rollout

Do not submit the template for approval, mutate production channel settings,
or send a real customer message as part of code verification. Use a mock Graph
transport (`WHATSAPP_GRAPH_BASE_URL`) and disable the worker when testing
enqueue behavior. The focused transport test is:

```sh
pnpm --filter @workspace/api-server test:service-appointment-whatsapp
```

Before enabling a dealer, verify the approved template in Meta and perform a
non-customer mock send that confirms the request contains a template body
component with exactly eight ordered text parameters, language `en`, and name
`service_appointment_confirmed`.# WhatsApp service appointment template setup

The service booking **Remind** action uses the server-owned, dealer-scoped
Meta WhatsApp utility template `service_appointment_confirmed`. It is sent
only after the booking has status `acknowledged` (confirmed), and only from an
explicit staff click. Confirming a booking does not send a WhatsApp message or
an email.

## Meta approval requirements

Create and approve this template in each dealership's WhatsApp Business
Account before deploying the feature:

- **Name:** `service_appointment_confirmed`
- **Category:** Utility
- **Language:** English (`en`)
- **Header:** `Service Appointment Confirmed` (static text; no header variable)
- **Body (exact copy):**

  ```text
  Hi {{1}}, your service appointment at {{2}} is confirmed.

  Booking reference: {{3}}
  Service: {{4}}
  Date: {{5}}
  Time: {{6}}
  Vehicle: {{7}}
  Registration: {{8}}

  Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.

  Thank you. We look forward to welcoming you for your vehicle care.
  ```

The body must have exactly eight text variables in this order:

1. Customer name
2. Dealership name
3. Booking reference (`RO-` plus the persisted service-order id)
4. Persisted service type
5. Appointment date formatted in the dealership's saved IANA timezone
6. Appointment time formatted in the dealership's saved IANA timezone
7. Persisted vehicle description
8. Persisted registration number (or the truthful `Not recorded` value when
   the booking has no registration)

The dealership name is used for `{{2}}`. Do not add punctuation, variables, a
footer, buttons, or a dynamic header to the approved template. Meta template
names and languages are case-sensitive.

## Channel configuration

Each dealership must have its own enabled WhatsApp channel with a valid
WABA/phone-number ID and encrypted access token. The application resolves the
channel by the active dealership and never falls back to another dealership's
sender. The existing generic outside-24-hour service template setting remains
for other WhatsApp flows; this appointment action always uses the exact
template above.

No SMTP credentials or customer email address are required for this action.
Phone opt-out (`STOP`), reviewed-import suppression, dealer scoping, outbox
deduplication, retries, provider receipts, and terminal error reporting are
applied by the existing WhatsApp outbox pipeline. A queued row is not reported
as sent; the UI reports `queued` until the provider accepts it.

## Safe verification and rollout

Do not submit the template for approval, mutate production channel settings,
or send a real customer message as part of code verification. Use a mock Graph
transport (`WHATSAPP_GRAPH_BASE_URL`) and disable the worker when testing
enqueue behavior. The focused transport test is:

```sh
pnpm --filter @workspace/api-server test:service-appointment-whatsapp
```

Before enabling a dealer, verify the approved template in Meta and perform a
non-customer mock send that confirms the request contains a template body
component with exactly eight ordered text parameters, language `en`, and name
`service_appointment_confirmed`.# WhatsApp service appointment template setup

The service booking **Remind** action uses the server-owned, dealer-scoped
Meta WhatsApp utility template `service_appointment_confirmed`. It is sent
only after the booking has status `acknowledged` (confirmed), and only from an
explicit staff click. Confirming a booking does not send a WhatsApp message or
an email.

## Meta approval requirements

Create and approve this template in each dealership's WhatsApp Business
Account before deploying the feature:

- **Name:** `service_appointment_confirmed`
- **Category:** Utility
- **Language:** English (`en`)
- **Header:** `Service Appointment Confirmed` (static text; no header variable)
- **Body (exact copy):**

  ```text
  Hi {{1}}, your service appointment at {{2}} is confirmed.

  Booking reference: {{3}}
  Service: {{4}}
  Date: {{5}}
  Time: {{6}}
  Vehicle: {{7}}
  Registration: {{8}}

  Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.

  Thank you. We look forward to welcoming you for your vehicle care.
  ```

The body must have exactly eight text variables in this order:

1. Customer name
2. Dealership name
3. Booking reference (`RO-` plus the persisted service-order id)
4. Persisted service type
5. Appointment date formatted in the dealership's saved IANA timezone
6. Appointment time formatted in the dealership's saved IANA timezone
7. Persisted vehicle description
8. Persisted registration number (or the truthful `Not recorded` value when
   the booking has no registration)

The dealership name is used for `{{2}}`. Do not add punctuation, variables, a
footer, buttons, or a dynamic header to the approved template. Meta template
names and languages are case-sensitive.

## Channel configuration

Each dealership must have its own enabled WhatsApp channel with a valid
WABA/phone-number ID and encrypted access token. The application resolves the
channel by the active dealership and never falls back to another dealership's
sender. The existing generic outside-24-hour service template setting remains
for other WhatsApp flows; this appointment action always uses the exact
template above.

No SMTP credentials or customer email address are required for this action.
Phone opt-out (`STOP`), reviewed-import suppression, dealer scoping, outbox
deduplication, retries, provider receipts, and terminal error reporting are
applied by the existing WhatsApp outbox pipeline. A queued row is not reported
as sent; the UI reports `queued` until the provider accepts it.

## Safe verification and rollout

Do not submit the template for approval, mutate production channel settings,
or send a real customer message as part of code verification. Use a mock Graph
transport (`WHATSAPP_GRAPH_BASE_URL`) and disable the worker when testing
enqueue behavior. The focused transport test is:

```sh
pnpm --filter @workspace/api-server test:service-appointment-whatsapp
```

Before enabling a dealer, verify the approved template in Meta and perform a
non-customer mock send that confirms the request contains a template body
component with exactly eight ordered text parameters, language `en`, and name
`service_appointment_confirmed`.# WhatsApp service appointment template setup

The service booking **Remind** action uses the server-owned, dealer-scoped
Meta WhatsApp utility template `service_appointment_confirmed`. It is sent
only after the booking has status `acknowledged` (confirmed), and only from an
explicit staff click. Confirming a booking does not send a WhatsApp message or
an email.

## Meta approval requirements

Create and approve this template in each dealership's WhatsApp Business
Account before deploying the feature:

- **Name:** `service_appointment_confirmed`
- **Category:** Utility
- **Language:** English (`en`)
- **Header:** `Service Appointment Confirmed` (static text; no header variable)
- **Body (exact copy):**

  ```text
  Hi {{1}}, your service appointment at {{2}} is confirmed.

  Booking reference: {{3}}
  Service: {{4}}
  Date: {{5}}
  Time: {{6}}
  Vehicle: {{7}}
  Registration: {{8}}

  Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.

  Thank you. We look forward to welcoming you for your vehicle care.
  ```

The body must have exactly eight text variables in this order:

1. Customer name
2. Dealership name
3. Booking reference (`RO-` plus the persisted service-order id)
4. Persisted service type
5. Appointment date formatted in the dealership's saved IANA timezone
6. Appointment time formatted in the dealership's saved IANA timezone
7. Persisted vehicle description
8. Persisted registration number (or the truthful `Not recorded` value when
   the booking has no registration)

The dealership name is used for `{{2}}`. Do not add punctuation, variables, a
footer, buttons, or a dynamic header to the approved template. Meta template
names and languages are case-sensitive.

## Channel configuration

Each dealership must have its own enabled WhatsApp channel with a valid
WABA/phone-number ID and encrypted access token. The application resolves the
channel by the active dealership and never falls back to another dealership's
sender. The existing generic outside-24-hour service template setting remains
for other WhatsApp flows; this appointment action always uses the exact
template above.

No SMTP credentials or customer email address are required for this action.
Phone opt-out (`STOP`), reviewed-import suppression, dealer scoping, outbox
deduplication, retries, provider receipts, and terminal error reporting are
applied by the existing WhatsApp outbox pipeline. A queued row is not reported
as sent; the UI reports `queued` until the provider accepts it.

## Safe verification and rollout

Do not submit the template for approval, mutate production channel settings,
or send a real customer message as part of code verification. Use a mock Graph
transport (`WHATSAPP_GRAPH_BASE_URL`) and disable the worker when testing
enqueue behavior. The focused transport test is:

```sh
pnpm --filter @workspace/api-server test:service-appointment-whatsapp
```

Before enabling a dealer, verify the approved template in Meta and perform a
non-customer mock send that confirms the request contains a template body
component with exactly eight ordered text parameters, language `en`, and name
`service_appointment_confirmed`.# WhatsApp service appointment template setup

The service booking **Remind** action uses the server-owned, dealer-scoped
Meta WhatsApp utility template `service_appointment_confirmed`. It is sent
only after the booking has status `acknowledged` (confirmed), and only from an
explicit staff click. Confirming a booking does not send a WhatsApp message or
an email.

## Meta approval requirements

Create and approve this template in each dealership's WhatsApp Business
Account before deploying the feature:

- **Name:** `service_appointment_confirmed`
- **Category:** Utility
- **Language:** English (`en`)
- **Header:** `Service Appointment Confirmed` (static text; no header variable)
- **Body (exact copy):**

  ```text
  Hi {{1}}, your service appointment at {{2}} is confirmed.

  Booking reference: {{3}}
  Service: {{4}}
  Date: {{5}}
  Time: {{6}}
  Vehicle: {{7}}
  Registration: {{8}}

  Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.

  Thank you. We look forward to welcoming you for your vehicle care.
  ```

The body must have exactly eight text variables in this order:

1. Customer name
2. Dealership name
3. Booking reference (`RO-` plus the persisted service-order id)
4. Persisted service type
5. Appointment date formatted in the dealership's saved IANA timezone
6. Appointment time formatted in the dealership's saved IANA timezone
7. Persisted vehicle description
8. Persisted registration number (or the truthful `Not recorded` value when
   the booking has no registration)

The dealership name is used for `{{2}}`. Do not add punctuation, variables, a
footer, buttons, or a dynamic header to the approved template. Meta template
names and languages are case-sensitive.

## Channel configuration

Each dealership must have its own enabled WhatsApp channel with a valid
WABA/phone-number ID and encrypted access token. The application resolves the
channel by the active dealership and never falls back to another dealership's
sender. The existing generic outside-24-hour service template setting remains
for other WhatsApp flows; this appointment action always uses the exact
template above.

No SMTP credentials or customer email address are required for this action.
Phone opt-out (`STOP`), reviewed-import suppression, dealer scoping, outbox
deduplication, retries, provider receipts, and terminal error reporting are
applied by the existing WhatsApp outbox pipeline. A queued row is not reported
as sent; the UI reports `queued` until the provider accepts it.

## Safe verification and rollout

Do not submit the template for approval, mutate production channel settings,
or send a real customer message as part of code verification. Use a mock Graph
transport (`WHATSAPP_GRAPH_BASE_URL`) and disable the worker when testing
enqueue behavior. The focused transport test is:

```sh
pnpm --filter @workspace/api-server test:service-appointment-whatsapp
```

Before enabling a dealer, verify the approved template in Meta and perform a
non-customer mock send that confirms the request contains a template body
component with exactly eight ordered text parameters, language `en`, and name
`service_appointment_confirmed`.# WhatsApp service appointment template setup

The service booking **Remind** action uses the server-owned, dealer-scoped
Meta WhatsApp utility template `service_appointment_confirmed`. It is sent
only after the booking has status `acknowledged` (confirmed), and only from an
explicit staff click. Confirming a booking does not send a WhatsApp message or
an email.

## Meta approval requirements

Create and approve this template in each dealership's WhatsApp Business
Account before deploying the feature:

- **Name:** `service_appointment_confirmed`
- **Category:** Utility
- **Language:** English (`en`)
- **Header:** `Service Appointment Confirmed` (static text; no header variable)
- **Body (exact copy):**

  ```text
  Hi {{1}}, your service appointment at {{2}} is confirmed.

  Booking reference: {{3}}
  Service: {{4}}
  Date: {{5}}
  Time: {{6}}
  Vehicle: {{7}}
  Registration: {{8}}

  Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.

  Thank you. We look forward to welcoming you for your vehicle care.
  ```

The body must have exactly eight text variables in this order:

1. Customer name
2. Dealership name
3. Booking reference (`RO-` plus the persisted service-order id)
4. Persisted service type
5. Appointment date formatted in the dealership's saved IANA timezone
6. Appointment time formatted in the dealership's saved IANA timezone
7. Persisted vehicle description
8. Persisted registration number (or the truthful `Not recorded` value when
   the booking has no registration)

The dealership name is used for `{{2}}`. Do not add punctuation, variables, a
footer, buttons, or a dynamic header to the approved template. Meta template
names and languages are case-sensitive.

## Channel configuration

Each dealership must have its own enabled WhatsApp channel with a valid
WABA/phone-number ID and encrypted access token. The application resolves the
channel by the active dealership and never falls back to another dealership's
sender. The existing generic outside-24-hour service template setting remains
for other WhatsApp flows; this appointment action always uses the exact
template above.

No SMTP credentials or customer email address are required for this action.
Phone opt-out (`STOP`), reviewed-import suppression, dealer scoping, outbox
deduplication, retries, provider receipts, and terminal error reporting are
applied by the existing WhatsApp outbox pipeline. A queued row is not reported
as sent; the UI reports `queued` until the provider accepts it.

## Safe verification and rollout

Do not submit the template for approval, mutate production channel settings,
or send a real customer message as part of code verification. Use a mock Graph
transport (`WHATSAPP_GRAPH_BASE_URL`) and disable the worker when testing
enqueue behavior. The focused transport test is:

```sh
pnpm --filter @workspace/api-server test:service-appointment-whatsapp
```

Before enabling a dealer, verify the approved template in Meta and perform a
non-customer mock send that confirms the request contains a template body
component with exactly eight ordered text parameters, language `en`, and name
`service_appointment_confirmed`.