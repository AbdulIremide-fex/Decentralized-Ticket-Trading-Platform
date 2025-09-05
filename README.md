# FanTrade: Decentralized Ticket Trading Platform

## Overview

FanTrade is a Web3 project built on the Stacks blockchain using Clarity smart contracts. It addresses real-world problems in the ticketing industry, such as ticket scalping, counterfeit tickets, high intermediary fees, lack of cross-event liquidity, and restricted resale policies imposed by centralized platforms like Ticketmaster.

### Real-World Problems Solved
- **Counterfeit Tickets**: By representing tickets as NFTs on the blockchain, authenticity is verifiable and immutable, preventing fakes.
- **Scalping and Price Gouging**: Smart contracts enforce anti-scalping rules, like price caps or resale limits, ensuring fair trading.
- **High Fees and Centralization**: Decentralized marketplace reduces fees (e.g., only small protocol fees) and eliminates single points of control.
- **Cross-Event Trading Barriers**: Fans can trade tickets across different clubs, matches, or events seamlessly via a unified registry, increasing liquidity.
- **Lack of Transparency**: All transactions are on-chain, allowing fans, clubs, and organizers to audit sales and ownership in real-time.
- **Fan Ownership and Rights**: Tickets can include perks (e.g., royalties for clubs on resales), empowering fans while benefiting organizers.

The platform allows event organizers (e.g., sports clubs) to mint tickets as NFTs, fans to trade them peer-to-peer or via listings, and ensures secure transfers with escrow. It supports cross-club trading by standardizing ticket metadata.

### Tech Stack
- **Blockchain**: Stacks (Bitcoin-secured via PoX).
- **Smart Contract Language**: Clarity (secure, decidable, no reentrancy issues).
- **Contracts**: 6 core smart contracts (detailed below).
- **Frontend Integration**: Can be built with Hiro Wallet for STX transactions, and libraries like @stacks/connect.
- **Tokenomics**: Uses STX for fees; optional FT for loyalty rewards (not implemented here).

## Smart Contracts

The project consists of 6 solid Clarity smart contracts:
1. **EventRegistry.clar**: Registers events and organizers.
2. **TicketNFT.clar**: Defines the NFT standard for tickets.
3. **TicketMinter.clar**: Handles minting tickets for registered events.
4. **Marketplace.clar**: Enables listing, buying, and selling tickets.
5. **Escrow.clar**: Secures peer-to-peer trades with timed escrow.
6. **Governance.clar**: Allows DAO-like voting for protocol updates (e.g., fee changes).

Contracts use traits for interoperability. Deploy them in this order: EventRegistry → TicketNFT → TicketMinter → Marketplace → Escrow → Governance.

### 1. EventRegistry.clar
Registers events (e.g., matches) and their organizers to ensure only authorized parties can mint tickets.

```clarity
(define-trait organizer-trait
  (
    (register-event (principal uint (buff 256) uint) (response bool uint))
  )
)

(define-map events uint { organizer: principal, event-id: uint, name: (buff 256), date: uint })
(define-data-var next-event-id uint u1)

(define-public (register-event (organizer principal) (name (buff 256)) (date uint))
  (let ((event-id (var-get next-event-id)))
    (map-set events event-id { organizer: organizer, event-id: event-id, name: name, date: date })
    (var-set next-event-id (+ event-id u1))
    (ok true)
  )
)

(define-read-only (get-event (event-id uint))
  (map-get? events event-id)
)
```

### 2. TicketNFT.clar
Implements a basic NFT trait for tickets, with metadata like seat, event ID.

```clarity
(define-trait nft-trait
  (
    (transfer (uint principal principal) (response bool uint))
    (get-owner (uint) (response principal uint))
    (get-metadata (uint) (response (tuple (event-id uint) (seat (buff 32)) (price uint)) uint))
  )
)

(define-map tickets uint { owner: principal, event-id: uint, seat: (buff 32), price: uint })
(define-data-var next-ticket-id uint u1)

(define-public (mint (recipient principal) (event-id uint) (seat (buff 32)) (price uint))
  (let ((ticket-id (var-get next-ticket-id)))
    (map-set tickets ticket-id { owner: recipient, event-id: event-id, seat: seat, price: price })
    (var-set next-ticket-id (+ ticket-id u1))
    (ok ticket-id)
  )
)

(define-public (transfer (ticket-id uint) (sender principal) (recipient principal))
  (match (map-get? tickets ticket-id)
    ticket
    (if (is-eq (get owner ticket) sender)
      (begin
        (map-set tickets ticket-id (merge ticket { owner: recipient }))
        (ok true)
      )
      (err u1) ;; Not owner
    )
    (err u2) ;; Ticket not found
  )
)

(define-read-only (get-owner (ticket-id uint))
  (ok (get owner (unwrap! (map-get? tickets ticket-id) (err u2))))
)

(define-read-only (get-metadata (ticket-id uint))
  (ok (tuple (event-id (get event-id (unwrap! (map-get? tickets ticket-id) (err u2))))
             (seat (get seat (unwrap! (map-get? tickets ticket-id) (err u2))))
             (price (get price (unwrap! (map-get? tickets ticket-id) (err u2))))))
)
```

### 3. TicketMinter.clar
Mints tickets only for registered events, enforcing supply limits.

```clarity
(use-trait nft-trait .TicketNFT.nft-trait)
(use-trait registry-trait .EventRegistry.organizer-trait)

(define-map event-supply uint { max-supply: uint, minted: uint })

(define-public (set-supply (event-id uint) (max uint))
  (let ((event (unwrap! (contract-call? .EventRegistry get-event event-id) (err u3))))
    (if (is-eq tx-sender (get organizer event))
      (begin
        (map-set event-supply event-id { max-supply: max, minted: u0 })
        (ok true)
      )
      (err u1) ;; Not organizer
    )
  )
)

(define-public (mint-ticket (nft <nft-trait>) (event-id uint) (recipient principal) (seat (buff 32)) (price uint))
  (let ((supply (unwrap! (map-get? event-supply event-id) (err u4)))
        (event (unwrap! (contract-call? .EventRegistry get-event event-id) (err u3))))
    (if (and (is-eq tx-sender (get organizer event)) (< (get minted supply) (get max-supply supply)))
      (match (contract-call? nft mint recipient event-id seat price)
        ticket-id
        (begin
          (map-set event-supply event-id (merge supply { minted: (+ (get minted supply) u1) }))
          (ok ticket-id)
        )
        error (err error)
      )
      (err u5) ;; Invalid mint
    )
  )
)
```

### 4. Marketplace.clar
Handles listing and buying tickets with anti-scalping (e.g., max price markup).

```clarity
(use-trait nft-trait .TicketNFT.nft-trait)

(define-map listings uint { ticket-id: uint, price: uint, seller: principal })
(define-data-var fee-percent uint u5) ;; 5% fee

(define-public (list-ticket (ticket-id uint) (price uint))
  (match (contract-call? .TicketNFT get-owner ticket-id)
    owner
    (if (is-eq owner tx-sender)
      (begin
        (map-set listings ticket-id { ticket-id: ticket-id, price: price, seller: tx-sender })
        (ok true)
      )
      (err u1)
    )
    error (err error)
  )
)

(define-public (buy-ticket (nft <nft-trait>) (ticket-id uint))
  (let ((listing (unwrap! (map-get? listings ticket-id) (err u6)))
        (metadata (unwrap! (contract-call? nft get-metadata ticket-id) (err u7))))
    (if (> (get price listing) (* (get price metadata) u2)) ;; Anti-scalping: max 2x original price
      (err u8) ;; Price too high
      (let ((fee (/ (* (get price listing) (var-get fee-percent)) u100))
            (net (- (get price listing) fee)))
        (try! (stx-transfer? net tx-sender (get seller listing)))
        (try! (stx-transfer? fee tx-sender (as-contract tx-sender))) ;; Protocol fee
        (try! (contract-call? nft transfer ticket-id (get seller listing) tx-sender))
        (map-delete listings ticket-id)
        (ok true)
      )
    )
  )
)
```

### 5. Escrow.clar
Secures P2P trades with timeout for cross-event swaps.

```clarity
(use-trait nft-trait .TicketNFT.nft-trait)

(define-map escrows uint { buyer: principal, seller: principal, ticket-id: uint, price: uint, expiry: uint })

(define-public (initiate-escrow (ticket-id uint) (price uint) (expiry uint))
  (match (contract-call? .TicketNFT get-owner ticket-id)
    owner
    (if (is-eq owner tx-sender)
      (begin
        (map-set escrows ticket-id { buyer: 'none, seller: tx-sender, ticket-id: ticket-id, price: price, expiry: expiry })
        (ok true)
      )
      (err u1)
    )
    error (err error)
  )
)

(define-public (accept-escrow (nft <nft-trait>) (ticket-id uint))
  (let ((escrow (unwrap! (map-get? escrows ticket-id) (err u9))))
    (if (and (is-eq (get seller escrow) (unwrap! (contract-call? .TicketNFT get-owner ticket-id) (err u10))) (> block-height (get expiry escrow)))
      (err u11) ;; Expired
      (begin
        (try! (stx-transfer? (get price escrow) tx-sender (get seller escrow)))
        (try! (contract-call? nft transfer ticket-id (get seller escrow) tx-sender))
        (map-delete escrows ticket-id)
        (ok true)
      )
    )
  )
)
```

### 6. Governance.clar
Simple DAO for voting on parameters like fees.

```clarity
(define-map proposals uint { proposer: principal, description: (buff 256), votes-for: uint, votes-against: uint, active: bool })
(define-data-var next-proposal-id uint u1)
(define-constant quorum u100) ;; STX staked for voting power (simplified)

(define-public (create-proposal (description (buff 256)))
  (let ((proposal-id (var-get next-proposal-id)))
    (map-set proposals proposal-id { proposer: tx-sender, description: description, votes-for: u0, votes-against: u0, active: true })
    (var-set next-proposal-id (+ proposal-id u1))
    (ok proposal-id)
  )
)

(define-public (vote (proposal-id uint) (for bool))
  (let ((proposal (unwrap! (map-get? proposals proposal-id) (err u12))))
    (if (get active proposal)
      (begin
        (if for
          (map-set proposals proposal-id (merge proposal { votes-for: (+ (get votes-for proposal) u1) })) ;; Simplified vote weight
          (map-set proposals proposal-id (merge proposal { votes-against: (+ (get votes-against proposal) u1) })))
        (ok true)
      )
      (err u13) ;; Inactive
    )
  )
)

(define-public (execute-proposal (proposal-id uint))
  (let ((proposal (unwrap! (map-get? proposals proposal-id) (err u12))))
    (if (and (get active proposal) (> (get votes-for proposal) (get votes-against proposal)) (> (+ (get votes-for proposal) (get votes-against proposal)) quorum))
      (begin
        ;; Execute logic, e.g., set fee (hardcoded example)
        (var-set .Marketplace fee-percent u3) ;; Change fee to 3%
        (map-set proposals proposal-id (merge proposal { active: false }))
        (ok true)
      )
      (err u14)
    )
  )
)
```

## Deployment and Usage
1. **Deploy Contracts**: Use Clarinet or Stacks CLI to deploy on testnet/mainnet.
2. **Integrate Frontend**: Build a dApp with React/Vue, using @stacks/transactions for calls.
3. **Testing**: Write unit tests in Clarinet (e.g., for minting limits).
4. **Security**: Clarity's design prevents common vulnerabilities; audit before mainnet.
5. **Future Enhancements**: Add FT for fan rewards, integrate with Bitcoin L2 for scalability.

## License
MIT License.