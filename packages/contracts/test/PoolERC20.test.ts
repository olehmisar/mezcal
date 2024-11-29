import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, noir, typedDeployments } from "hardhat";
import { parseUnits, snapshottedBeforeEach } from "../shared/utils";
import {
  IERC20__factory,
  MockERC20,
  MockERC20__factory,
  MockSwap__factory,
  PoolERC20,
  PoolERC20__factory,
} from "../typechain-types";
import { EncryptionService } from "./EncryptionService";
import { INCLUDE_UNCOMMITTED, RollupService } from "./RollupService";

describe("PoolERC20", () => {
  let alice: SignerWithAddress,
    bob: SignerWithAddress,
    charlie: SignerWithAddress;
  const aliceSecretKey =
    "0x118f09bc73ec486db2030077142f2bceba2a4d4c9e0f6147d776f8ca8ec02ff1";
  const bobSecretKey =
    "0x2120f33c0d324bfe571a18c1d5a1c9cdc6db60621e35bc78be1ced339f936a71";
  const charlieSecretKey =
    "0x038c0439a42280637b202fd2f0d25d6e8e3c11908eab966a6d85bd6797eed5d5";
  let pool: PoolERC20;
  let usdc: MockERC20;
  let btc: MockERC20;
  let service: RollupService;
  let encryption: EncryptionService;
  snapshottedBeforeEach(async () => {
    [alice, bob, charlie] = await ethers.getSigners();
    await typedDeployments.fixture();
    pool = PoolERC20__factory.connect(
      (await typedDeployments.get("PoolERC20")).address,
      alice,
    );

    usdc = await new MockERC20__factory(alice).deploy("USD Coin", "USDC");
    btc = await new MockERC20__factory(alice).deploy("Bitcoin", "BTC");

    await usdc.mintForTests(alice, await parseUnits(usdc, "1000000"));
    await usdc.connect(alice).approve(pool, ethers.MaxUint256);
  });

  beforeEach(async () => {
    encryption = new EncryptionService();
    service = new RollupService(
      pool,
      encryption,
      await ethers.resolveProperties({
        shield: getCircuit("shield"),
        transfer: getCircuit("transfer"),
        execute: getCircuit("execute"),
        rollup: getCircuit("rollup"),
      }),
    );
    console.log(
      "noteHashTreeRoot",
      ethers.hexlify(
        (await service.getNoteHashTree()).getRoot(INCLUDE_UNCOMMITTED),
      ),
    );
    console.log(
      "nullifiersTreeRoot",
      ethers.hexlify((await service.getNullifierTree()).getRoot()),
    );
  });

  it("shields", async () => {
    const amount = 100n;
    const {
      note: { randomness },
    } = await service.shield({
      account: alice,
      token: usdc,
      amount,
      secretKey: aliceSecretKey,
    });

    await service.rollup();
    expect(await service.getEmittedNotes(aliceSecretKey)).to.deep.equal([
      {
        owner: await service.computeCompleteWaAddress(aliceSecretKey),
        token: await usdc.getAddress(),
        value: amount,
        randomness,
      },
    ]);
    expect(await service.balanceOf(usdc, aliceSecretKey)).to.equal(amount);
    expect(await usdc.balanceOf(pool)).to.equal(amount);
  });

  it("shields many", async () => {
    await service.shield({
      account: alice,
      token: usdc,
      amount: 100n,
      secretKey: aliceSecretKey,
    });
    await service.shield({
      account: alice,
      token: usdc,
      amount: 200n,
      secretKey: aliceSecretKey,
    });
    await service.rollup();
    expect(await service.balanceOf(usdc, aliceSecretKey)).to.equal(300n);

    await service.shield({
      account: alice,
      token: usdc,
      amount: 300n,
      secretKey: aliceSecretKey,
    });
    await service.rollup();
    expect(await service.balanceOf(usdc, aliceSecretKey)).to.equal(600n);
  });

  it("transfers", async () => {
    // prepare
    const amount = 500n;
    await service.shield({
      account: alice,
      token: usdc,
      amount,
      secretKey: aliceSecretKey,
    });
    await service.rollup();

    // interact
    const [note] = await service.getEmittedNotes(aliceSecretKey);
    const transferAmount = 123n;
    const { nullifier, changeNote, toNote } = await service.transfer({
      secretKey: aliceSecretKey,
      fromNote: note,
      to: await service.computeCompleteWaAddress(bobSecretKey),
      amount: transferAmount,
    });

    const pendingTxsAfter = (await pool.getAllPendingTxs()).slice(1);
    expect(pendingTxsAfter).to.deep.equal([
      [
        false, // rolledUp
        [
          // note hashes
          await service.hashNote(changeNote),
          await service.hashNote(toNote),
        ],
        [
          // nullifiers
          nullifier,
        ],
      ],
    ]);

    await service.rollup();

    expect(await service.balanceOf(usdc, aliceSecretKey)).to.equal(
      amount - transferAmount,
    );
    expect(await service.balanceOf(usdc, bobSecretKey)).to.equal(
      transferAmount,
    );
  });

  it("transfers many", async () => {
    await service.shield({
      account: alice,
      token: usdc,
      amount: 100n,
      secretKey: aliceSecretKey,
    });
    await service.rollup();
    const [shieldedNote] = await service.getEmittedNotes(aliceSecretKey);

    await service.transfer({
      secretKey: aliceSecretKey,
      fromNote: shieldedNote,
      to: await service.computeCompleteWaAddress(bobSecretKey),
      amount: 30n,
    });
    // TODO: split notes even if they are not rolled up
    // const {  } = await service.transfer({
    //   secretKey: aliceSecretKey,
    //   fromNote: shieldedNote,
    //   to: await service.computeWaAddress(charlieSecretKey),
    //   amount: 10n,
    // });
    await service.rollup();
    const [bobNote] = await service.getEmittedNotes(bobSecretKey);

    await service.transfer({
      secretKey: bobSecretKey,
      fromNote: bobNote,
      to: await service.computeCompleteWaAddress(charlieSecretKey),
      amount: 10n,
    });
    await service.rollup();

    expect(await service.balanceOf(usdc, aliceSecretKey)).to.equal(100n - 30n);
    expect(await service.balanceOf(usdc, bobSecretKey)).to.equal(30n - 10n);
    expect(await service.balanceOf(usdc, charlieSecretKey)).to.equal(10n);
  });

  it("executes", async () => {
    const mockSwap = await new MockSwap__factory(alice).deploy();
    await usdc.mintForTests(mockSwap, 9999999999);
    await btc.mintForTests(mockSwap, 9999999999);

    const initialBalance = 120n;
    const amountIn = 50n;
    const amountOut = 100n;

    await service.shield({
      account: alice,
      token: usdc,
      amount: initialBalance,
      secretKey: aliceSecretKey,
    });
    await service.rollup();
    const [shieldedNote] = await service.getEmittedNotes(aliceSecretKey);

    const tokenIn = await btc.getAddress();
    const tokenOut = await usdc.getAddress();

    const calls = [
      {
        to: tokenOut,
        data: IERC20__factory.createInterface().encodeFunctionData("approve", [
          await mockSwap.getAddress(),
          amountOut,
        ]),
      },
      {
        to: await mockSwap.getAddress(),
        data: mockSwap.interface.encodeFunctionData("swap", [
          tokenIn,
          tokenOut,
          amountIn,
          amountOut,
        ]),
      },
    ];

    const to = await service.computeCompleteWaAddress(bobSecretKey);
    await service.execute({
      fromSecretKey: aliceSecretKey,
      fromNotes: [shieldedNote],
      to,
      amountsIn: [
        {
          token: tokenIn,
          amount: amountIn.toString(),
        },
      ],
      amountsOut: [
        {
          token: tokenOut,
          amount: amountOut.toString(),
        },
      ],
      calls,
    });

    expect(await service.balanceOf(usdc, aliceSecretKey)).to.eq(
      initialBalance - amountOut,
    );
    expect(await service.balanceOf(btc, bobSecretKey)).to.eq(amountIn);
    expect(await usdc.balanceOf(pool)).to.eq(initialBalance - amountOut);
    expect(await btc.balanceOf(pool)).to.eq(amountIn);
  });

  it.skip("fails to transfer more than balance", async () => {});
  it.skip("fails to transfer if note does not exist", async () => {});
  it.skip("fails to transfer if note is pending", async () => {});
  it.skip("fails to transfer if note is nullified", async () => {});
});

async function getCircuit(name: string) {
  // TODO: update hardhat-plugin-noir to support 0.39.0 backends
  const { Noir } = (await eval(
    `import("@noir-lang/noir_js")`,
  )) as typeof import("@noir-lang/noir_js");
  const { UltraPlonkBackend } = (await eval(
    `import("@aztec/bb.js")`,
  )) as typeof import("@aztec/bb.js");
  const circuit = await noir.getCircuitJson(name);
  const noir_ = new Noir(circuit);
  const backend = new UltraPlonkBackend(circuit.bytecode);
  return { noir: noir_, backend: backend };
}
