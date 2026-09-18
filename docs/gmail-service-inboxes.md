# Dealer-owned Gmail service inboxes

The API can poll an explicitly allowlisted dealer's existing saved
`smtp_connections` Gmail credentials for website service-booking forms. No
additional secret or integration is used.

## Configuration

Set the non-secret environment variable to a JSON array:

```text
GMAIL_SERVICE_INBOXES=[{"dealerId":99,"initialSince":"2026-09-18T16:40:00.000Z"}]
```

- `dealerId` must be a positive integer and is the only source of dealer
  ownership. There is no default-dealer or cross-dealer fallback.
- `initialSince` is optional. It must be a canonical ISO instant that is not in
  the future. If omitted, the first-run watermark is the current time.
- The initial value is inserted only when the stable dealer/mailbox marker is
  missing. An existing marker is preserved on every later start.
- Each listed dealer must be active and have an enabled `smtp_connections` row
  with host `smtp.gmail.com`, username, and encrypted saved password.
- IMAP is fixed to `imap.gmail.com:993` with TLS. SMTP connection status is
  historical and does not prove that Google currently accepts the password.
- A normalized mailbox already assigned to `GMAIL_USER` or
  `SALESADMIN_GMAIL_USER` is rejected as an ownership conflict.

Only matching “Website Contact Form | Book Your Service Online” messages are
handled. Both seen and unseen messages after the watermark are eligible for
recovery. Metadata and the idempotency ledger are checked before source is
fetched. Unrelated messages are not classified, read, marked, or ledgered.
Delivery keys include the dealer and normalized-mailbox identity.

The legacy default Gmail and GT Automotive `SALESADMIN_GMAIL_*` paths retain
their existing unseen-only behavior and keys. A rejected or failed explicit
mailbox does not stop those paths.

## Verification

These checks use fakes and do not connect to a mailbox or mutate a database:

```sh
pnpm --filter @workspace/api-server test:gmail-service-intake
pnpm --filter @workspace/api-server typecheck
```

Authentication failures are reported only with fixed diagnostic codes; raw
Google responses and credentials must never be logged.