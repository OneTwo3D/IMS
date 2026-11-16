### Receiving and transfer dialogs usable on a phone (UI)

- **Fixed: the Receive Goods dialog (purchase order) and the New Stock Transfer dialog no longer break at phone width (360-414 px).** Below the `sm` breakpoint both dialogs fill the screen and each line is a stacked card: product on top, then Ordered / Received / Remaining (receiving) or the From / To stock (transfer), then a full-width quantity input and, when receiving, the warehouse select, all tap-sized (44 px) with 16 px text so iOS does not zoom. The desktop tables are unchanged, and no behaviour or server action changed.

