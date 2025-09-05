// ticket-nft.test.ts
import { describe, expect, it, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface TokenMetadata {
  eventId: number;
  seat: string;
  price: number;
  royaltyPercent: number;
}

interface Token {
  owner: string;
  eventId: number;
  seat: string;
  price: number;
  royaltyPercent: number;
  royaltyReceiver: string;
  burned: boolean;
}

interface ContractState {
  lastId: number;
  contractOwner: string;
  paused: boolean;
  minter: string;
  tokens: Map<number, Token>;
  tokenUris: Map<number, string>;
  approved: Map<number, { operator: string; approved: boolean }>;
}

// Mock contract implementation
class TicketNFTMock {
  private state: ContractState = {
    lastId: 0,
    contractOwner: "deployer",
    paused: false,
    minter: "deployer",
    tokens: new Map(),
    tokenUris: new Map(),
    approved: new Map(),
  };

  private ERR_NOT_OWNER = 100;
  private ERR_NOT_FOUND = 101;
  private ERR_INVALID_ID = 102;
  private ERR_ALREADY_BURNED = 103;
  private ERR_NOT_AUTHORIZED = 104;
  private ERR_INVALID_ROYALTY = 105;
  private ERR_PAUSED = 106;
  private ERR_INVALID_SEAT = 107;
  private ERR_METADATA_EXISTS = 108;
  private MAX_SEAT_LEN = 32;
  private MAX_ROYALTY_PERCENT = 100;

  getLastTokenId(): ClarityResponse<number> {
    return { ok: true, value: this.state.lastId };
  }

  getTokenUri(id: number): ClarityResponse<string | null> {
    return { ok: true, value: this.state.tokenUris.get(id) ?? null };
  }

  getOwner(id: number): ClarityResponse<string | null> {
    const token = this.state.tokens.get(id);
    if (!token || token.burned) {
      return { ok: true, value: null };
    }
    return { ok: true, value: token.owner };
  }

  getMetadata(id: number): ClarityResponse<TokenMetadata | null> {
    const token = this.state.tokens.get(id);
    if (!token || token.burned) {
      return { ok: true, value: null };
    }
    return {
      ok: true,
      value: {
        eventId: token.eventId,
        seat: token.seat,
        price: token.price,
        royaltyPercent: token.royaltyPercent,
      },
    };
  }

  setPaused(caller: string, newPaused: boolean): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = newPaused;
    return { ok: true, value: true };
  }

  setMinter(caller: string, newMinter: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.minter = newMinter;
    return { ok: true, value: true };
  }

  mint(
    caller: string,
    recipient: string,
    eventId: number,
    seat: string,
    price: number,
    royaltyPercent: number,
    royaltyReceiver: string,
    uri?: string
  ): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (caller !== this.state.minter) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (seat.length > this.MAX_SEAT_LEN) {
      return { ok: false, value: this.ERR_INVALID_SEAT };
    }
    if (royaltyPercent > this.MAX_ROYALTY_PERCENT) {
      return { ok: false, value: this.ERR_INVALID_ROYALTY };
    }
    const newId = this.state.lastId + 1;
    if (this.state.tokens.has(newId)) {
      return { ok: false, value: this.ERR_METADATA_EXISTS };
    }
    this.state.tokens.set(newId, {
      owner: recipient,
      eventId,
      seat,
      price,
      royaltyPercent,
      royaltyReceiver,
      burned: false,
    });
    if (uri) {
      this.state.tokenUris.set(newId, uri);
    }
    this.state.lastId = newId;
    return { ok: true, value: newId };
  }

  transfer(caller: string, id: number, sender: string, recipient: string): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const token = this.state.tokens.get(id);
    if (!token || token.burned || token.owner !== sender || caller !== sender) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    token.owner = recipient;
    return { ok: true, value: true };
  }

  burn(caller: string, id: number, sender: string): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const token = this.state.tokens.get(id);
    if (!token || token.burned || token.owner !== sender || caller !== sender) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    token.burned = true;
    return { ok: true, value: true };
  }

  setRoyalty(caller: string, id: number, newPercent: number): ClarityResponse<boolean> {
    const token = this.state.tokens.get(id);
    if (!token || token.owner !== caller) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    if (newPercent > this.MAX_ROYALTY_PERCENT) {
      return { ok: false, value: this.ERR_INVALID_ROYALTY };
    }
    token.royaltyPercent = newPercent;
    return { ok: true, value: true };
  }

  approve(caller: string, id: number, operator: string, approved: boolean): ClarityResponse<boolean> {
    const token = this.state.tokens.get(id);
    if (!token || token.owner !== caller) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    this.state.approved.set(id, { operator, approved });
    return { ok: true, value: true };
  }

  transferFrom(caller: string, id: number, owner: string, recipient: string): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const approval = this.state.approved.get(id);
    if (!approval || approval.operator !== caller || !approval.approved) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const token = this.state.tokens.get(id);
    if (!token || token.owner !== owner) {
      return { ok: false, value: this.ERR_NOT_FOUND };
    }
    token.owner = recipient;
    return { ok: true, value: true };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  minter: "minter",
  user1: "user1",
  user2: "user2",
  operator: "operator",
};

describe("TicketNFT Contract", () => {
  let contract: TicketNFTMock;

  beforeEach(() => {
    contract = new TicketNFTMock();
  });

  it("should initialize with last-id 0", () => {
    expect(contract.getLastTokenId()).toEqual({ ok: true, value: 0 });
  });

  it("should allow minter to mint new ticket", () => {
    const mintResult = contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer,
      "ipfs://uri"
    );
    expect(mintResult).toEqual({ ok: true, value: 1 });
    expect(contract.getOwner(1)).toEqual({ ok: true, value: accounts.user1 });
    expect(contract.getTokenUri(1)).toEqual({ ok: true, value: "ipfs://uri" });
    expect(contract.getMetadata(1)).toEqual({
      ok: true,
      value: { eventId: 1, seat: "Seat A1", price: 100, royaltyPercent: 5 },
    });
  });

  it("should prevent non-minter from minting", () => {
    const mintResult = contract.mint(
      accounts.user1,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    expect(mintResult).toEqual({ ok: false, value: 104 });
  });

  it("should allow owner to transfer ticket", () => {
    contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    const transferResult = contract.transfer(accounts.user1, 1, accounts.user1, accounts.user2);
    expect(transferResult).toEqual({ ok: true, value: true });
    expect(contract.getOwner(1)).toEqual({ ok: true, value: accounts.user2 });
  });

  it("should prevent non-owner from transferring", () => {
    contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    const transferResult = contract.transfer(accounts.user2, 1, accounts.user1, accounts.user2);
    expect(transferResult).toEqual({ ok: false, value: 100 });
  });

  it("should allow burning of ticket", () => {
    contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    const burnResult = contract.burn(accounts.user1, 1, accounts.user1);
    expect(burnResult).toEqual({ ok: true, value: true });
    expect(contract.getOwner(1)).toEqual({ ok: true, value: null });
    expect(contract.getMetadata(1)).toEqual({ ok: true, value: null });
  });

  it("should prevent burning already burned ticket", () => {
    contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    contract.burn(accounts.user1, 1, accounts.user1);
    const burnResult = contract.burn(accounts.user1, 1, accounts.user1);
    expect(burnResult).toEqual({ ok: false, value: 100 });
  });

  it("should allow setting royalty", () => {
    contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    const setRoyaltyResult = contract.setRoyalty(accounts.user1, 1, 10);
    expect(setRoyaltyResult).toEqual({ ok: true, value: true });
    const metadata = contract.getMetadata(1);
    expect(metadata.ok && metadata.value?.royaltyPercent).toBe(10);
  });

  it("should prevent invalid royalty percent", () => {
    contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    const setRoyaltyResult = contract.setRoyalty(accounts.user1, 1, 101);
    expect(setRoyaltyResult).toEqual({ ok: false, value: 105 });
  });

  it("should allow approved operator to transfer from", () => {
    contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    contract.approve(accounts.user1, 1, accounts.operator, true);
    const transferFromResult = contract.transferFrom(accounts.operator, 1, accounts.user1, accounts.user2);
    expect(transferFromResult).toEqual({ ok: true, value: true });
    expect(contract.getOwner(1)).toEqual({ ok: true, value: accounts.user2 });
  });

  it("should prevent unapproved transfer from", () => {
    contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    const transferFromResult = contract.transferFrom(accounts.operator, 1, accounts.user1, accounts.user2);
    expect(transferFromResult).toEqual({ ok: false, value: 104 });
  });

  it("should pause and prevent operations", () => {
    contract.setPaused(accounts.deployer, true);
    const mintResult = contract.mint(
      accounts.deployer,
      accounts.user1,
      1,
      "Seat A1",
      100,
      5,
      accounts.deployer
    );
    expect(mintResult).toEqual({ ok: false, value: 106 });
  });
});