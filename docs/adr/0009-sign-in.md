# ADR-0009: Sign-in inside the app with an emailed one-time code

- **Status:** Accepted
- **Date:** 2026-10-23
- **Resolves:** ADR-0002 open item 3 (the sign-in flow); the ADR-0005 follow-up on the Cognito domain and callback URLs; HLD §11 ADR-0009
- **Changes requirements:** amends REQ-007; adds REQ-083 to REQ-085
- **Amends:** [ADR-0002](0002-guest-identity.md) (how sign-in works; renewing the session before it ends); [ADR-0005](0005-toolchain-and-deployment.md) (no Cognito domain or callback URLs; Essentials plan with SES email; calls to Cognito are cross-origin)

## Context

ADR-0002 decided who owns the data on a device: a local guest until sign-in, then a profile bound to one Cognito account. It left open how the user actually signs in (open item 3), and ADR-0005 needs the answer to configure the user pool.

These facts constrain the design:

- **Sign-in needs the network, and the network is often poor.** It happens on hotel Wi-Fi or roaming data as often as at home. It must take few, small requests and survive a dropped one.
- **Many users run the installed app.** On iOS, an app installed to the home screen keeps its storage apart from Safari, and opens other sites in an in-app browser. A sign-in that redirects to another site is reported to finish in a window that never hands the result back to the app.
- **Users sign in rarely:** once per device, then only when the session ends. A password chosen months earlier is easily forgotten, and resetting it needs the email anyway.
- **A Cognito session ends a fixed time after sign-in.** Refreshing tokens, even with rotation, never extends the refresh token's lifetime. Wherever the user is when it ends, they have to sign in again.
- **Cognito supports passwordless sign-in.** On the Essentials feature plan, with email sent through Amazon SES, it emails a one-time code. Accounts can be created without a password, and a confirmed sign-up continues straight into a signed-in session.

Decision drivers, in priority order:

1. Sign-in works inside the installed app on every platform, without leaving it.
2. Few small requests, tolerant of drops and of the user switching to their mail app.
3. Nothing for users to remember or reset.
4. A session never ends unexpectedly in the middle of a trip.
5. One way to authenticate API calls (ADR-0002), and little infrastructure.

## Decision

### 1. The sign-in screens are part of the app

The app's own screens call the Cognito user-pools API directly: `SignUp`, `ConfirmSignUp`, `InitiateAuth`, `RespondToAuthChallenge`, `GetTokensFromRefreshToken` and `RevokeToken`.

- There are no managed login pages, no OAuth redirects, no Cognito domain and no callback URLs.
- The screens are part of the cached app shell, so they open without the network, and the app never navigates away. Its state survives sign-in, so the confirmation of ADR-0002 decision 5 appears right after it.
- These operations need no AWS credentials. The client sends them as plain JSON requests from WASM, with no AWS SDK.
- They go to Cognito's regional endpoint. Apart from presigned media downloads (ADR-0005), they are the app's only cross-origin requests, and the Content Security Policy allows that one endpoint. They happen only at sign-in and token refresh, and the preflight for Cognito's single URL is cached.

### 2. An email address and a one-time code; no passwords

The username is the email address, compared without regard to case. One screen serves new and returning users:

1. The user enters their email address, and the app calls `SignUp` without a password.
2. **New address:** Cognito emails a confirmation code. The user enters it, and `ConfirmSignUp` returns a session that signs the user in through `InitiateAuth` (`USER_AUTH`), with no second code.
3. **Known address** (`SignUp` answers `UsernameExistsException`): the app calls `InitiateAuth` (`USER_AUTH`, preferred challenge `EMAIL_OTP`). Cognito emails a code, and `RespondToAuthChallenge` with that code returns the tokens. If the account's sign-up was never confirmed, this code confirms it.

Either way the user receives one email and types one code.

**The code screen:**

- shows the address, with a way to change it, and offers to resend the code;
- marks the field `autocomplete="one-time-code"`, so platforms that can fill in codes from messages offer to;
- keeps the attempt (address, step, Cognito session, expiry) in IndexedDB. If the system unloads the installed app while the user reads their email, the app reopens at code entry (REQ-084);
- allows the longest attempt Cognito permits, 15 minutes, because email can arrive slowly on a poor connection. When the attempt lapses, the screen offers a new code.

Cognito requires the password factor to stay enabled in a user pool that allows passwordless sign-in. Accounts are created without a password, and the app has no password screens (REQ-083).

### 3. Email goes through Amazon SES

Email codes require the user pool to send through SES. Cognito's built-in email also has a daily limit below what production needs.

- **Prod:** an SES domain identity for the prod domain (ADR-0005), with its DKIM records in the Route 53 hosted zone, sending from an address on that domain. The account must leave the SES sandbox before the first real user.
- **Dev:** SES in its sandbox, which sends only to verified addresses: the developers' own.

### 4. Tokens and the length of a session

- **API calls carry the access token.** The Cognito JWT authorizer (HLD §5) checks the issuer, takes the app client ID as the audience, and requires the `aws.cognito.signin.user.admin` scope. Cognito's ID tokens carry the same audience, so without the scope check they would be accepted too.
- **Access and ID tokens** last an hour and are kept in memory. The **refresh token** is kept in IndexedDB with the profile (ADR-0002 decision 8). While online, the client refreshes the tokens before the access token expires, with `GetTokensFromRefreshToken`.
- **No refresh-token rotation.** With rotation, a refresh whose response is lost leaves the client with a token that stops working at most 60 seconds later. On a connection that drops for minutes, that signs the user out. Rotation doesn't lengthen the session either.
- **Renewing before the session ends.** The session ends a fixed time after sign-in, set by the refresh-token lifetime (ADR-0002). The refresh token is opaque, so the client records when it signed in and takes the lifetime from its configuration. While online, it offers renewal without blocking (REQ-085):
  - when less than the renewal window remains;
  - earlier, when a planned or ongoing travel (ADR-0007) ends after the session would, so that a trip doesn't begin with a session that will run out halfway.

  Renewing is the sign-in of decision 2 for the address the app already knows, so it costs one code. The account doesn't change, so nothing migrates. The new refresh token replaces the old one, which is revoked.
- **If the session ends anyway,** for example while offline, the app keeps working locally and asks the user to sign in again once online (REQ-007). ADR-0002 decision 6 makes sure it is the same account.
- **Cancelling migration and signing out** revoke the refresh token with `RevokeToken`, best effort while online (ADR-0002 decisions 5 and 7).
- **Before keeping new tokens,** the client reads the account's `sub` from the ID token and applies ADR-0002 decision 6. If the account differs and unsynced changes exist, it revokes the new tokens.

### 5. User pool and app client

| Setting | Value |
|---|---|
| Feature plan | Essentials |
| Sign-in identifier | Email address, not case-sensitive |
| Self sign-up | On; the code verifies the address |
| Allowed first factors | Email one-time code; password (required by Cognito, unused) |
| Email | SES (decision 3) |
| App client | Public, no secret. Auth flows `ALLOW_USER_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`. No OAuth flows, domain or callback URLs. |
| Sign-in attempt validity (`AuthSessionValidity`) | 15 minutes |
| Access and ID tokens | 1 hour |
| Refresh token | 90 days; no rotation; revocation on |
| User existence errors | Prevented (`PreventUserExistenceErrors`) |

## Considered options

1. **Cognito's managed login pages, with an authorization code and PKCE.** The least code, and social sign-in would come with it. Rejected:
   - the redirect leaves the installed app, which is reported to break sign-in on iOS;
   - each sign-in loads Cognito's pages and then reloads the app over a slow link;
   - every environment needs a Cognito domain and callback URLs.
2. **Email address and password, with SRP.** Available on the cheaper Lite plan. Rejected (user decision):
   - users forget a password they typed months ago, and resetting it needs an emailed code anyway;
   - the client would need the SRP protocol in WASM, and a reset flow.
3. **Passkeys alongside email codes.** Faster sign-in with Face ID or a fingerprint. Deferred (user decision): it adds WebAuthn work, and it can be added later without changing anything here. Cognito accepts our own domain as the passkey relying-party ID, so passkeys would use the prod domain (ADR-0005), which must not change once they exist.
4. **Sign in with Google or Apple.** Deferred (user decision): Cognito federates only through its managed login pages, which brings back option 1's redirects, and both providers need app registrations.
5. **Magic links instead of codes.** One tap in the email. Rejected: the link opens in the browser, which on iOS doesn't share storage with the installed app, so the sign-in would land in the wrong place. Cognito would also need custom-auth Lambda triggers.
6. **Calling Cognito through our own API** (`/api/auth/…`). Same origin, so no CORS, and the refresh token could live in an `HttpOnly` cookie, out of scripts' reach. Rejected for the POC: one more function on the sign-in path, for requests that happen rarely. Worth revisiting in a security review.
7. **Refresh-token rotation.** Recommended by AWS. Rejected: see decision 4.
8. **A much longer refresh-token lifetime, such as a year, instead of renewal.** Fewer prompts. Rejected: a stolen token stays useful far longer, and the session would still end without warning one day.

## Consequences

- **Good:**
  - sign-in works the same in the browser and in the installed app on every platform, and never leaves the app;
  - a sign-in takes two or three small requests and one email;
  - no passwords to remember, reset or leak;
  - a session runs out mid-trip only if the user ignores the renewal prompts;
  - no Cognito domain, callback URLs or hosted pages to brand.
- **Bad:**
  - we build the sign-in screens and handle Cognito's errors ourselves;
  - signing in needs access to email, and a slow email slows sign-in;
  - Essentials and SES cost money above 10,000 monthly active users, and SES needs setting up, including leaving its sandbox, before launch;
  - `SignUp` reveals whether an address has an account;
  - calls to Cognito are cross-origin, an exception to ADR-0005's single origin;
  - Cognito keeps the password factor enabled, unused;
  - no social sign-in.
- **Follow-ups:**
  - auth/migration LLD: screen states, Cognito error handling and retries, the account-content check of ADR-0002, renewal prompts;
  - CDK: the user pool and app client of decision 5, the SES identity and its DNS records;
  - parameter values in `docs/ear.md`.

## Parameters

Initial values, to be pinned in `docs/ear.md`:

| Parameter | Initial value | Basis |
|---|---|---|
| Sign-in attempt validity | 15 minutes | Cognito's maximum. Email can arrive slowly on a poor connection. |
| Access and ID token lifetime | 1 hour | Cognito's default; refreshed without the user noticing while online. |
| Refresh-token lifetime | 90 days | ADR-0002. Counted from sign-in; renewal starts a new one. |
| Renewal window | 30 days | Gives a traveller weeks of chances to be online when the prompt appears. |

## Validation spike

1. Sign-up, sign-in and renewal with email codes in Safari, Chrome and Firefox, and in the app installed on iOS and Android, calling Cognito from WASM. Include the app being unloaded while the user reads their email.
2. `SignUp` answers `UsernameExistsException` for an existing address, confirmed or not, and an `EMAIL_OTP` sign-in confirms an unconfirmed account.
3. The session returned by `ConfirmSignUp` signs the user in without a second code.
4. Retries after lost responses: a repeated `InitiateAuth` (does the first code stay valid?) and a repeated `RespondToAuthChallenge`.
5. Access tokens from `USER_AUTH` pass the HTTP API's JWT authorizer with the client ID as audience and the `aws.cognito.signin.user.admin` scope required, and ID tokens are refused.
6. How long codes take to arrive through SES, their length, and how long they stay valid.
7. Which platforms offer to fill in an emailed code.

## References

- [HLD](../hld.md) §1, §3, §5, §10; [requirements](../requirements.md) REQ-001–REQ-007, REQ-054–REQ-058, REQ-083–REQ-085.
- [ADR-0002](0002-guest-identity.md) (identities, migration, tokens); [ADR-0005](0005-toolchain-and-deployment.md) (CDK, single origin, prod domain); [ADR-0007](0007-travels.md) (travel dates, used for renewal).
- AWS, *Amazon Cognito Developer Guide*: authentication flows (choice-based and passwordless sign-in, passkeys), refresh tokens, email settings. *Amazon Cognito user pools API Reference*: `SignUp`, `ConfirmSignUp`, `CreateUserPoolClient`.
- AWS, *Amazon API Gateway Developer Guide*: JWT authorizers for HTTP APIs.
- M. Firtman, *What's new on iOS 12.2 for Progressive Web Apps*, 2019: installed web apps open other sites in an in-app browser.
