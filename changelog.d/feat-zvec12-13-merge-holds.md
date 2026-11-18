### Merge holds in Mintsoft (fulfilment, behind a setting)

- IMS can now hold every order of a same-customer group in Mintsoft (awaiting confirmation) so they can be merged there, instead of only flagging them. It is behind the setting `wms_merge_hold_enabled`, which is off by default; with it off nothing changes. It also needs merge candidates on Flag.
  - IMS never merges and never releases a hold: a person merges and confirms the order in Mintsoft. There is no release code.
  - The hold is recorded in IMS, not as a Mintsoft or WooCommerce note. One task under Exceptions > Raise a warehouse query names the held orders (and any that could not be held) with the EU and FedEx warnings.
  - A hold that fails is shown as "Not held" and retried when the failure was a connection problem, not when Mintsoft refused it.
  - After 4 hours (`MERGE_HOLD_REMIND_HOURS`) a hold that is still in place raises one overdue task, a warning in the activity log and a notification, and the order badge turns red.
  - While an order is held, IMS sends no change, cancel or withdrawal hold to Mintsoft for it: a change shows as "Act in Mintsoft" under Exceptions, and a withdrawal or cancel raises a task for a person.
  - The hold clears when Mintsoft's status leaves awaiting confirmation, when a merge is detected, or when the order despatches.
