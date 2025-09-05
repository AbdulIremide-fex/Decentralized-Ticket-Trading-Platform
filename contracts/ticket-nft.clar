;; ticket-nft.clar
;; Sophisticated NFT contract for tickets in FanTrade platform.
;; Implements enhanced SIP-009-like trait with additional features:
;; - Metadata storage with event details.
;; - Ownership transfer with hooks.
;; - Burning for expired tickets.
;; - Royalty support for event organizers.
;; - Access control for minters.
;; - Query functions for batch operations.
;; - Error handling with specific codes.
;; - Uses latest Clarity syntax with optional types, tuples, etc.

;; Traits
(define-trait nft-trait
  (
    ;; Core NFT functions
    (get-last-token-id () (response uint uint))
    (get-token-uri (uint) (response (optional (string-ascii 256)) uint))
    (get-owner (uint) (response (optional principal) uint))
    (transfer (uint principal principal) (response bool uint))

    ;; Extended functions
    (burn (uint principal) (response bool uint))
    (get-metadata (uint) (response (optional {event-id: uint, seat: (string-ascii 32), price: uint, royalty-percent: uint}) uint))
    (set-royalty (uint uint principal) (response bool uint))
  )
)

;; Constants
(define-constant ERR-NOT-OWNER u100)
(define-constant ERR-NOT-FOUND u101)
(define-constant ERR-INVALID-ID u102)
(define-constant ERR-ALREADY-BURNED u103)
(define-constant ERR-NOT-AUTHORIZED u104)
(define-constant ERR-INVALID-ROYALTY u105)
(define-constant ERR-PAUSED u106)
(define-constant ERR-INVALID-SEAT u107)
(define-constant ERR-METADATA-EXISTS u108)
(define-constant MAX-SEAT-LEN u32)
(define-constant MAX-ROYALTY-PERCENT u100)

;; Data Vars
(define-data-var last-id uint u0)
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var minter principal tx-sender)

;; Data Maps
(define-map tokens uint
  {
    owner: principal,
    event-id: uint,
    seat: (string-ascii 32),
    price: uint,
    royalty-percent: uint,
    royalty-receiver: principal,
    burned: bool
  }
)

(define-map token-uris uint (string-ascii 256))
(define-map approved uint { operator: principal, approved: bool })

;; Private Functions
(define-private (is-owner (id uint) (sender principal))
  (match (map-get? tokens id)
    token (and (is-eq (get owner token) sender) (not (get burned token)))
    false
  )
)

(define-private (transfer-royalty (amount uint) (percent uint) (receiver principal))
  (if (> percent u0)
    (let ((royalty (/ (* amount percent) u100)))
      (try! (stx-transfer? royalty tx-sender receiver))
      (- amount royalty)
    )
    amount
  )
)

;; Public Functions

(define-public (set-paused (new-paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) (err ERR-NOT-AUTHORIZED))
    (var-set paused new-paused)
    (ok true)
  )
)

(define-public (set-minter (new-minter principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) (err ERR-NOT-AUTHORIZED))
    (var-set minter new-minter)
    (ok true)
  )
)

(define-public (mint (recipient principal) (event-id uint) (seat (string-ascii 32)) (price uint) (royalty-percent uint) (royalty-receiver principal) (uri (optional (string-ascii 256))))
  (begin
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (is-eq tx-sender (var-get minter)) (err ERR-NOT-AUTHORIZED))
    (asserts! (<= (len seat) MAX-SEAT-LEN) (err ERR-INVALID-SEAT))
    (asserts! (<= royalty-percent MAX-ROYALTY-PERCENT) (err ERR-INVALID-ROYALTY))
    (let ((new-id (+ (var-get last-id) u1)))
      (asserts! (is-none (map-get? tokens new-id)) (err ERR-METADATA-EXISTS))
      (map-set tokens new-id
        {
          owner: recipient,
          event-id: event-id,
          seat: seat,
          price: price,
          royalty-percent: royalty-percent,
          royalty-receiver: royalty-receiver,
          burned: false
        }
      )
      (match uri
        some-uri (map-set token-uris new-id some-uri)
        none
      )
      (var-set last-id new-id)
      (print { type: "mint", id: new-id, recipient: recipient })
      (ok new-id)
    )
  )
)

(define-public (transfer (id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (is-owner id sender) (err ERR-NOT-OWNER))
    (match (map-get? tokens id)
      token
      (begin
        (map-set tokens id (merge token { owner: recipient }))
        (print { type: "transfer", id: id, from: sender, to: recipient })
        (ok true)
      )
      (err ERR-NOT-FOUND)
    )
  )
)

(define-public (burn (id uint) (sender principal))
  (begin
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (is-owner id sender) (err ERR-NOT-OWNER))
    (match (map-get? tokens id)
      token
      (if (get burned token)
        (err ERR-ALREADY-BURNED)
        (begin
          (map-set tokens id (merge token { burned: true }))
          (print { type: "burn", id: id, owner: sender })
          (ok true)
        )
      )
      (err ERR-NOT-FOUND)
    )
  )
)

(define-public (set-royalty (id uint) (new-percent uint) (sender principal))
  (begin
    (asserts! (is-owner id sender) (err ERR-NOT-OWNER))
    (asserts! (<= new-percent MAX-ROYALTY-PERCENT) (err ERR-INVALID-ROYALTY))
    (match (map-get? tokens id)
      token
      (begin
        (map-set tokens id (merge token { royalty-percent: new-percent }))
        (ok true)
      )
      (err ERR-NOT-FOUND)
    )
  )
)

(define-public (approve (id uint) (operator principal) (approved bool))
  (begin
    (asserts! (is-owner id tx-sender) (err ERR-NOT-OWNER))
    (map-set approved id { operator: operator, approved: approved })
    (ok true)
  )
)

(define-public (transfer-from (id uint) (owner principal) (recipient principal))
  (begin
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (match (map-get? approved id)
      approval
      (if (and (is-eq (get operator approval) tx-sender) (get approved approval))
        (try! (transfer id owner recipient))
        (err ERR-NOT-AUTHORIZED)
      )
      (err ERR-NOT-AUTHORIZED)
    )
  )
)

;; Read-Only Functions

(define-read-only (get-last-token-id)
  (ok (var-get last-id))
)

(define-read-only (get-token-uri (id uint))
  (ok (map-get? token-uris id))
)

(define-read-only (get-owner (id uint))
  (match (map-get? tokens id)
    token (if (get burned token) (ok none) (ok (some (get owner token))))
    (ok none)
  )
)

(define-read-only (get-metadata (id uint))
  (match (map-get? tokens id)
    token (if (get burned token)
            (ok none)
            (ok (some {
              event-id: (get event-id token),
              seat: (get seat token),
              price: (get price token),
              royalty-percent: (get royalty-percent token)
            })))
    (ok none)
  )
)

(define-read-only (is-approved (id uint) (operator principal))
  (match (map-get? approved id)
    approval (and (is-eq (get operator approval) operator) (get approved approval))
    false
  )
)

(define-read-only (get-royalty-info (id uint))
  (match (map-get? tokens id)
    token { percent: (get royalty-percent token), receiver: (get royalty-receiver token) }
    { percent: u0, receiver: 'SP000000000000000000002Q6VF78 } ;; Default
  )
)

(define-read-only (batch-get-owners (ids (list 100 uint)))
  (map get-owner ids)
)

(define-read-only (get-contract-owner)
  (var-get contract-owner)
)

(define-read-only (is-paused)
  (var-get paused)
)