### WMS misc fixes (batch AG)
- A dispatch blocked by a refund-reservation release row in a status this version does not recognise now says so and says it needs a deploy that recognises it or an escalation; the row appears in Sync Exceptions (Integration outbox) marked as needing an administrator, without a Replay that cannot work.
