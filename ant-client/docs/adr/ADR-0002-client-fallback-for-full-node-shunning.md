# ADR-0002: Client-side fallback and diagnostics for full-node shunning

- **Status:** Proposed
- **Date:** 2026-06-25
- **Decision owners:** Mick
- **Reviewers:** <pending>
- **Supersedes:** none
- **Superseded by:** none
- **Related:** saorsa-node ADR-0003 (node-side full-node detection, penalisation, and eviction); ADR-0001 (adopt ADRs)

## Context

Full storage nodes are rejecting client uploads. When a chunk's close group
contains a full node, the client's put to that node fails and the upload can fall
short of write quorum, even though the network as a whole still has capacity. This
ADR covers the **client's** role in the wider full-node-shunning plan; the node and
membership roles are covered by saorsa-node ADR-0003.

The decision rests on behaviour verified directly in the node and client code, not
on assumption:

- The client selects peers via a DHT lookup of the `CLOSE_GROUP_SIZE = 7` closest,
  and write quorum is `CLOSE_GROUP_MAJORITY = 4` (`ant-core/src/data/client/chunk.rs:308`).
  Both constants come from `ant-protocol` and are not client-configurable.
- Today the client only falls back **among the 7 quoted peers**
  (`ant-core/src/data/client/chunk.rs:273-358`).
- A node accepts a client put from **any** peer whose own local 20-closest view of
  the address includes one of the proof's quote issuers; it does **not** require the
  receiving node to have been quoted (`saorsa-node` `src/payment/verifier.rs:811-837,
  942-1003`; `src/storage/handler.rs:283-285`). The issuer-closeness width is
  `PAID_QUOTE_ISSUER_CLOSENESS_WIDTH = K_BUCKET_SIZE = 20`, nearly 3× the close
  group. **Consequence: the same `ProofOfPayment` is reusable by further peers
  within that 20-wide window — fallback needs no re-quote and no re-pay.**
- A full node returns a **distinct** `ProtocolError::StorageFailed` *before* payment
  verification (`saorsa-node` `src/storage/handler.rs:274-281`), whereas a price-floor
  shortfall returns a `Payment` error. The client currently **flattens both** into
  `Error::RemotePut` (`ant-core/src/data/client/chunk.rs:417-443`), losing the
  distinction it needs to respond correctly.
- GET returns on **first success** and is read-safe while at least one queried close
  peer holds the chunk; it does **not** expand its walk beyond K
  (`ant-core/src/data/client/chunk.rs:483-623`).

## Decision Drivers

- Unblock uploads when a *minority* of the close group is full, with no protocol or
  payment changes.
- Make the cause of a put failure legible so the client picks the right response
  (fall back, skip, or retry) instead of one opaque error.
- Stay strictly within the node's verified acceptance rules; never assume behaviour
  the node does not implement.
- Stay read-safe in the common case and flag the near-capacity boundary explicitly
  rather than silently relying on it.

## Considered Options

1. **Do nothing on the client; rely solely on node-side eviction to reshape close
   groups.** Rejected: leaves an immediate failure during the eviction convergence
   window and wastes the already-available 20-wide acceptance headroom.
2. **Re-quote and re-pay a fresh close group whenever a put fails.** Rejected
   outright, and a deliberate non-goal: it is unnecessary now that the proof is known
   to be reusable, and **we do not re-quote or top-up payment** under any failure. A
   peer whose local floor the existing payment does not clear is simply skipped.
3. **Extend client fallback to next-closest peers within the issuer-closeness
   window, reusing the existing proof, with error-class-aware handling (chosen).**

## Decision

- **Classify node rejections** instead of collapsing them into one `RemotePut`:
  `StorageFailed` (full) → fall back to a further peer; `Payment`/price-floor → this
  peer wants more than was paid, so **skip it and advance fallback** (we do **not**
  re-quote or top-up payment, and do not retry the same peer); transport/timeout →
  bounded retry.
- **Extend `chunk_put_to_close_group` fallback** from the 7 quoted peers to the
  next-closest peers from the same DHT walk, **reusing the same `ProofOfPayment`**,
  bounded by the `K_BUCKET_SIZE = 20` issuer-closeness window — beyond it the node
  provably rejects ("issuer not among this node's local K=20 closest"). Fallback is
  **best-effort**: whether a given far peer accepts depends on its own routing view
  and local price floor, which the client cannot see.
- **Quote/pay the quorum-witnessed close group, not the raw initial list.** The
  `CLOSE_GROUP_SIZE` peers that are quoted and paid are the *witnessed consensus*
  close group: the peers a quorum of the closest responders agree are closest to the
  address, taken in XOR order. This is intentionally **not** strictly the querying
  node's initial closest-`CLOSE_GROUP_SIZE` list — the witnessed/consensus model
  exists precisely so that a stale or biased local view cannot unilaterally pick the
  pay set, so a consensus peer surfaced in responder views may stand in for a stale
  initial peer. The widened put-target query (closest `20`) only *enlarges the put set
  and the responder pool*; the quote/quorum transcript is still scoped to
  `CLOSE_GROUP_SIZE`, leaving payment byte-for-byte unchanged.
- **Keep write quorum at `CLOSE_GROUP_MAJORITY = 4`.** Fallback changes *which* peers
  satisfy quorum, not the threshold.
- **Read availability:** rely on close-group convergence driven by node/membership
  eviction (saorsa-node ADR-0003) as the primary guarantee; keep GET-on-first-success
  plus the existing single retry. Do **not** widen the GET walk now. Explicitly flag
  the near-capacity read-gap — a chunk that lands *entirely* on fallback peers outside
  the queried 7 is unreadable until convergence shifts those peers into the close
  group — and gate any future GET-walk widening behind observed GET shortfalls in the
  near-capacity regime.

## Consequences

### Positive

- Uploads blocked by a single (or minority) full close peer now reach quorum via
  fallback, with no protocol, payment, or node change required.
- Failure causes are legible: full, under-paid, and transport failures get distinct,
  correct client responses.

### Negative / Trade-offs

- Fallback is best-effort and **bounded at the 20-wide window**; if more than
  `20 − 4` of the nearest peers refuse, quorum still cannot be met — the same
  near-capacity boundary the whole plan is bounded by.
- A **per-node price floor** can reject a fully-paid put even with free disk; because
  we do not re-quote or top-up, such a peer is simply skipped — so a neighbourhood
  priced above the paid median can still cause a quorum shortfall this ADR does not
  resolve.
- The near-capacity read-gap remains until convergence; we accept it for now rather
  than widen GET prematurely.
- More client-side branching and a retry/fallback budget to tune.

### Neutral / Operational

- Quorum and close-group constants remain owned by `ant-protocol`; this ADR does not
  change them.
- Adds one tunable: the fallback peer budget (how far down the next-closest list the
  client will try before giving up).

## Validation

- In a minority-full testnet, uploads that previously failed on a single full close
  peer reach quorum via fallback **without re-quoting or re-paying**.
- Tests required before this ADR is Accepted: error classification maps
  `StorageFailed` / `Payment` / transport correctly; fallback stops at the 20-window;
  quorum still requires 4 successes; a price-floor rejection skips the peer and
  advances fallback without re-quoting or retrying the same peer; GET stays read-safe
  while ≥1 queried close peer holds the chunk.
- Re-open trigger: if observed GET shortfalls reveal a persistent read-gap in the
  near-capacity regime, revisit widening the GET walk.

## Notes for AI-assisted work

AI tools may help draft this ADR, but **must not mark it Accepted without human
review**. Accepted ADRs are immutable: create a new superseding ADR rather than
editing this one.
