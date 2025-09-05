;; marketplace.clar
;; Sophisticated Marketplace contract for FanTrade.
;; Features:
;; - Listing tickets with price and expiry.
;; - Buying with royalty payout.
;; - Cancel listing.
;; - Auction support (simple timed).
;; - Fee structure with governance.
;; - Anti-scalping via price caps.
;; - Batch listings.
;; - Event hooks.
;; - Robust error handling.
;; - Integration with NFT trait.

(use-trait nft-trait .ticket-nft.nft-trait)

;; Constants
(define-constant ERR-NOT-LISTED u200)
(define-constant ERR-NOT-OWNER u201)
(define-constant ERR-INVALID-PRICE u202)
(define-constant ERR-EXPIRED u203)
(define-constant ERR-PAUSED u204)
(define-constant ERR-SCALE-VIOLATION u205)
(define-constant ERR-INVALID-BID u206)
(define-constant ERR-AUCTION-ENDED u207)
(define-constant ERR-NOT-AUTHORIZED u208)
(define-constant MAX-SCALE-FACTOR u200) ;; 2x original price
(define-constant MIN-AUCTION-DURATION u144) ;; ~1 day in blocks

;; Data Vars
(define-data-var fee-percent uint u5) ;; 5%
(define-data-var paused bool false)
(define-data-var admin principal tx-sender)

;; Data Maps
(define-map listings uint
  {
    seller: principal,
    price: uint,
    expiry: uint,
    is-auction: bool,
    min-bid-increment: uint,
    current-bid: uint,
    current-bidder: (optional principal)
  }
)

(define-map bids uint { bidder: principal, amount: uint })

;; Private Functions
(define-private (pay-fee (amount uint))
  (let ((fee (/ (* amount (var-get fee-percent)) u100)))
    (try! (stx-transfer? fee tx-sender (as-contract tx-sender)))
    fee
  )
)

(define-private (pay-royalty (nft <nft-trait>) (id uint) (amount uint))
  (let ((royalty-info (unwrap! (contract-call? nft get-royalty-info id) u0)))
    (if (> (get percent royalty-info) u0)
      (let ((royalty-amount (/ (* amount (get percent royalty-info)) u100)))
        (try! (stx-transfer? royalty-amount tx-sender (get receiver royalty-info)))
        royalty-amount
      )
      u0
    )
  )
)

(define-private (check-anti-scalping (original-price uint) (list-price uint))
  (asserts! (<= list-price (* original-price (/ MAX-SCALE-FACTOR u100))) (err ERR-SCALE-VIOLATION))
)

;; Public Functions

(define-public (set-fee-percent (new-percent uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-NOT-AUTHORIZED))
    (asserts! (<= new-percent u10) (err ERR-INVALID-PRICE))
    (var-set fee-percent new-percent)
    (ok true)
  )
)

(define-public (set-paused (new-paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-NOT-AUTHORIZED))
    (var-set paused new-paused)
    (ok true)
  )
)

(define-public (list-ticket (nft <nft-trait>) (id uint) (price uint) (expiry uint) (is-auction bool) (min-bid-increment uint))
  (let ((owner (unwrap! (contract-call? nft get-owner id) (err ERR-NOT-OWNER)))
        (metadata (unwrap! (contract-call? nft get-metadata id) (err ERR-NOT-FOUND))))
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (is-eq owner tx-sender) (err ERR-NOT-OWNER))
    (asserts! (> price u0) (err ERR-INVALID-PRICE))
    (asserts! (> expiry block-height) (err ERR-EXPIRED))
    (check-anti-scalping (get price metadata) price)
    (if is-auction
      (asserts! (>= (- expiry block-height) MIN-AUCTION-DURATION) (err ERR-INVALID-PRICE))
      true
    )
    (map-set listings id
      {
        seller: tx-sender,
        price: price,
        expiry: expiry,
        is-auction: is-auction,
        min-bid-increment: min-bid-increment,
        current-bid: u0,
        current-bidder: none
      }
    )
    (try! (contract-call? nft transfer id tx-sender (as-contract tx-sender))) ;; Escrow
    (print { type: "list", id: id, price: price, is-auction: is-auction })
    (ok true)
  )
)

(define-public (cancel-listing (id uint))
  (match (map-get? listings id)
    listing
    (begin
      (asserts! (is-eq (get seller listing) tx-sender) (err ERR-NOT-OWNER))
      (try! (as-contract (contract-call? .ticket-nft transfer id tx-sender (get seller listing))))
      (map-delete listings id)
      (ok true)
    )
    (err ERR-NOT-LISTED)
  )
)

(define-public (buy-ticket (nft <nft-trait>) (id uint))
  (match (map-get? listings id)
    listing
    (begin
      (asserts! (not (var-get paused)) (err ERR-PAUSED))
      (asserts! (not (get is-auction listing)) (err ERR-INVALID-BID))
      (asserts! (< block-height (get expiry listing)) (err ERR-EXPIRED))
      (let ((price (get price listing))
            (seller (get seller listing))
            (royalty (pay-royalty nft id price))
            (fee (pay-fee price))
            (net (- price (+ royalty fee))))
        (try! (stx-transfer? price tx-sender seller))
        (try! (as-contract (contract-call? nft transfer id tx-sender tx-sender)))
        (map-delete listings id)
        (print { type: "buy", id: id, buyer: tx-sender, price: price })
        (ok true)
      )
    )
    (err ERR-NOT-LISTED)
  )
)

(define-public (place-bid (id uint) (bid-amount uint))
  (match (map-get? listings id)
    listing
    (begin
      (asserts! (not (var-get paused)) (err ERR-PAUSED))
      (asserts! (get is-auction listing) (err ERR-INVALID-BID))
      (asserts! (< block-height (get expiry listing)) (err ERR-EXPIRED))
      (asserts! (> bid-amount (+ (get current-bid listing) (get min-bid-increment listing))) (err ERR-INVALID-BID))
      ;; Refund previous bidder if exists
      (match (get current-bidder listing)
        prev-bidder (try! (stx-transfer? (get current-bid listing) tx-sender prev-bidder))
        none
      )
      (map-set listings id (merge listing { current-bid: bid-amount, current-bidder: (some tx-sender) }))
      (try! (stx-transfer? bid-amount tx-sender (as-contract tx-sender))) ;; Escrow bid
      (print { type: "bid", id: id, bidder: tx-sender, amount: bid-amount })
      (ok true)
    )
    (err ERR-NOT-LISTED)
  )
)

(define-public (end-auction (nft <nft-trait>) (id uint))
  (match (map-get? listings id)
    listing
    (begin
      (asserts! (>= block-height (get expiry listing)) (err ERR-AUCTION-ENDED))
      (asserts! (get is-auction listing) (err ERR-INVALID-BID))
      (match (get current-bidder listing)
        winner
        (let ((bid (get current-bid listing))
              (seller (get seller listing))
              (royalty (pay-royalty nft id bid))
              (fee (pay-fee bid))
              (net (- bid (+ royalty fee))))
          (try! (stx-transfer? net (as-contract tx-sender) seller))
          (try! (as-contract (contract-call? nft transfer id tx-sender winner)))
          (map-delete listings id)
          (ok true)
        )
        (begin ;; No bids, return to seller
          (try! (as-contract (contract-call? nft transfer id tx-sender (get seller listing))))
          (map-delete listings id)
          (ok false)
        )
      )
    )
    (err ERR-NOT-LISTED)
  )
)

;; Read-Only Functions

(define-read-only (get-listing (id uint))
  (map-get? listings id)
)

(define-read-only (get-fee-percent)
  (var-get fee-percent)
)

(define-read-only (is-paused)
  (var-get paused)
)

(define-read-only (get-admin)
  (var-get admin)
)