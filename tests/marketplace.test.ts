import { describe, expect, it, beforeEach } from "vitest";

// Mock NFT trait interface
interface NFTTrait {
  getOwner(id: number): { ok: boolean; value: string | null };
  getMetadata(id: number): { ok: boolean; value: { price: number } | null };
  transfer(id: number, sender: string, recipient: string): { ok: boolean; value: boolean | number };
  getRoyaltyInfo(id: number): { percent: number; receiver: string };
}

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Listing {
  seller: string;
  price: number;
  expiry: number;
  isAuction: boolean;
  minBidIncrement: number;
  currentBid: number;
  currentBidder: string | null;
}

interface ContractState {
  feePercent: number;
  paused: boolean;
  admin: string;
  listings: Map<number, Listing>;
  // For simplicity, mock STX transfers as no-ops
}

// Mock Marketplace implementation
class MarketplaceMock {
  private state: ContractState = {
    feePercent: 5,
    paused: false,
    admin: "deployer",
    listings: new Map(),
  };

  private ERR_NOT_LISTED = 200;
  private ERR_NOT_OWNER = 201;
  private ERR_INVALID_PRICE = 202;
  private ERR_EXPIRED = 203;
  private ERR_PAUSED = 204;
  private ERR_SCALE_VIOLATION = 205;
  private ERR_INVALID_BID = 206;
  private ERR_AUCTION_ENDED = 207;
  private ERR_NOT_AUTHORIZED = 208;
  private MAX_SCALE_FACTOR = 200;
  private MIN_AUCTION_DURATION = 144;

  private currentBlock = 100; // Mock block height

  public nftMock: NFTTrait = {
    getOwner: (id) => ({ ok: true, value: this.nftOwners.get(id) ?? null }),
    getMetadata: (id) => ({ ok: true, value: this.nftMetadata.get(id) ?? null }),
    transfer: (id, sender, recipient) => {
      if (this.nftOwners.get(id) !== sender) return { ok: false, value: this.ERR_NOT_OWNER };
      this.nftOwners.set(id, recipient);
      return { ok: true, value: true };
    },
    getRoyaltyInfo: (id) => this.nftRoyalties.get(id) ?? { percent: 0, receiver: "deployer" },
  };

  private nftOwners: Map<number, string> = new Map();
  private nftMetadata: Map<number, { price: number }> = new Map();
  private nftRoyalties: Map<number, { percent: number; receiver: string }> = new Map();

  // Helper to set mock NFT data
  setNftData(id: number, owner: string, price: number, royaltyPercent: number) {
    this.nftOwners.set(id, owner);
    this.nftMetadata.set(id, { price });
    this.nftRoyalties.set(id, { percent: royaltyPercent, receiver: "royalty-receiver" });
  }

  // Mock block height advance
  advanceBlock(blocks: number) {
    this.currentBlock += blocks;
  }

  setFeePercent(caller: string, newPercent: number): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (newPercent > 10) {
      return { ok: false, value: this.ERR_INVALID_PRICE };
    }
    this.state.feePercent = newPercent;
    return { ok: true, value: true };
  }

  setPaused(caller: string, newPaused: boolean): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = newPaused;
    return { ok: true, value: true };
  }

  listTicket(
    caller: string,
    id: number,
    price: number,
    expiry: number,
    isAuction: boolean,
    minBidIncrement: number
  ): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const owner = this.nftMock.getOwner(id).value;
    if (!owner || owner !== caller) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    const metadata = this.nftMock.getMetadata(id).value;
    if (!metadata) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    if (price <= 0) {
      return { ok: false, value: this.ERR_INVALID_PRICE };
    }
    if (expiry <= this.currentBlock) {
      return { ok: false, value: this.ERR_EXPIRED };
    }
    if (price > (metadata.price * this.MAX_SCALE_FACTOR) / 100) {
      return { ok: false, value: this.ERR_SCALE_VIOLATION };
    }
    if (isAuction && expiry - this.currentBlock < this.MIN_AUCTION_DURATION) {
      return { ok: false, value: this.ERR_INVALID_PRICE };
    }
    this.state.listings.set(id, {
      seller: caller,
      price,
      expiry,
      isAuction,
      minBidIncrement,
      currentBid: 0,
      currentBidder: null,
    });
    this.nftMock.transfer(id, caller, "contract"); // Escrow
    return { ok: true, value: true };
  }

  cancelListing(caller: string, id: number): ClarityResponse<boolean> {
    const listing = this.state.listings.get(id);
    if (!listing) {
      return { ok: false, value: this.ERR_NOT_LISTED };
    }
    if (listing.seller !== caller) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    this.nftMock.transfer(id, "contract", listing.seller);
    this.state.listings.delete(id);
    return { ok: true, value: true };
  }

  buyTicket(caller: string, id: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const listing = this.state.listings.get(id);
    if (!listing) {
      return { ok: false, value: this.ERR_NOT_LISTED };
    }
    if (listing.isAuction) {
      return { ok: false, value: this.ERR_INVALID_BID };
    }
    if (this.currentBlock >= listing.expiry) {
      return { ok: false, value: this.ERR_EXPIRED };
    }
    // Mock payments as success
    this.nftMock.transfer(id, "contract", caller);
    this.state.listings.delete(id);
    return { ok: true, value: true };
  }

  placeBid(caller: string, id: number, bidAmount: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const listing = this.state.listings.get(id);
    if (!listing) {
      return { ok: false, value: this.ERR_NOT_LISTED };
    }
    if (!listing.isAuction) {
      return { ok: false, value: this.ERR_INVALID_BID };
    }
    if (this.currentBlock >= listing.expiry) {
      return { ok: false, value: this.ERR_EXPIRED };
    }
    // For the first bid, ensure bidAmount is at least price + minBidIncrement
    // For subsequent bids, ensure bidAmount is at least currentBid + minBidIncrement
    const minimumBid = listing.currentBid === 0 ? listing.price + listing.minBidIncrement : listing.currentBid + listing.minBidIncrement;
    if (bidAmount < minimumBid) {
      return { ok: false, value: this.ERR_INVALID_BID };
    }
    // Mock refund
    listing.currentBid = bidAmount;
    listing.currentBidder = caller;
    return { ok: true, value: true };
  }

  endAuction(id: number): ClarityResponse<boolean> {
    const listing = this.state.listings.get(id);
    if (!listing) {
      return { ok: false, value: this.ERR_NOT_LISTED };
    }
    if (this.currentBlock < listing.expiry) {
      return { ok: false, value: this.ERR_AUCTION_ENDED };
    }
    if (!listing.isAuction) {
      return { ok: false, value: this.ERR_INVALID_BID };
    }
    if (listing.currentBidder) {
      this.nftMock.transfer(id, "contract", listing.currentBidder);
    } else {
      this.nftMock.transfer(id, "contract", listing.seller);
    }
    this.state.listings.delete(id);
    return { ok: true, value: true };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  seller: "seller",
  buyer: "buyer",
  bidder1: "bidder1",
  bidder2: "bidder2",
};

describe("Marketplace Contract", () => {
  let contract: MarketplaceMock;

  beforeEach(() => {
    contract = new MarketplaceMock();
  });

  it("should allow admin to set fee percent", () => {
    const result = contract.setFeePercent(accounts.deployer, 3);
    expect(result).toEqual({ ok: true, value: true });
  });

  it("should prevent non-admin from setting fee", () => {
    const result = contract.setFeePercent(accounts.seller, 3);
    expect(result).toEqual({ ok: false, value: 208 });
  });

  it("should list a ticket for fixed price", () => {
    contract.setNftData(1, accounts.seller, 100, 5);
    const listResult = contract.listTicket(accounts.seller, 1, 150, 200, false, 0);
    expect(listResult).toEqual({ ok: true, value: true });
    expect(contract.nftMock.getOwner(1).value).toBe("contract");
  });

  it("should prevent listing above scale factor", () => {
    contract.setNftData(1, accounts.seller, 100, 5);
    const listResult = contract.listTicket(accounts.seller, 1, 300, 200, false, 0);
    expect(listResult).toEqual({ ok: false, value: 205 });
  });

  it("should allow buying fixed price listing", () => {
    contract.setNftData(1, accounts.seller, 100, 5);
    contract.listTicket(accounts.seller, 1, 150, 200, false, 0);
    const buyResult = contract.buyTicket(accounts.buyer, 1);
    expect(buyResult).toEqual({ ok: true, value: true });
    expect(contract.nftMock.getOwner(1).value).toBe(accounts.buyer);
  });

  it("should list auction and place bids", () => {
    contract.setNftData(1, accounts.seller, 100, 5);
    contract.listTicket(accounts.seller, 1, 100, 300, true, 10);
    const bid1 = contract.placeBid(accounts.bidder1, 1, 110);
    expect(bid1).toEqual({ ok: true, value: true });
    const bid2 = contract.placeBid(accounts.bidder2, 1, 130);
    expect(bid2).toEqual({ ok: true, value: true });
  });

  it("should prevent invalid bid", () => {
    contract.setNftData(1, accounts.seller, 100, 5);
    contract.listTicket(accounts.seller, 1, 100, 300, true, 10);
    const bid = contract.placeBid(accounts.bidder1, 1, 105);
    expect(bid).toEqual({ ok: false, value: 206 });
  });

  it("should end auction and award to winner", () => {
    contract.setNftData(1, accounts.seller, 100, 5);
    contract.listTicket(accounts.seller, 1, 100, 300, true, 10);
    contract.placeBid(accounts.bidder1, 1, 110);
    contract.advanceBlock(200);
    const endResult = contract.endAuction(1);
    expect(endResult).toEqual({ ok: true, value: true });
    expect(contract.nftMock.getOwner(1).value).toBe(accounts.bidder1);
  });

  it("should return to seller if no bids", () => {
    contract.setNftData(1, accounts.seller, 100, 5);
    contract.listTicket(accounts.seller, 1, 100, 300, true, 10);
    contract.advanceBlock(200);
    const endResult = contract.endAuction(1);
    expect(endResult).toEqual({ ok: true, value: true });
    expect(contract.nftMock.getOwner(1).value).toBe(accounts.seller);
  });

  it("should cancel listing", () => {
    contract.setNftData(1, accounts.seller, 100, 5);
    contract.listTicket(accounts.seller, 1, 150, 200, false, 0);
    const cancelResult = contract.cancelListing(accounts.seller, 1);
    expect(cancelResult).toEqual({ ok: true, value: true });
    expect(contract.nftMock.getOwner(1).value).toBe(accounts.seller);
  });

  it("should pause and prevent listing", () => {
    contract.setPaused(accounts.deployer, true);
    contract.setNftData(1, accounts.seller, 100, 5);
    const listResult = contract.listTicket(accounts.seller, 1, 150, 200, false, 0);
    expect(listResult).toEqual({ ok: false, value: 204 });
  });
});