<script lang="ts">
  import { lib } from "$lib";
  import SendForm from "$lib/components/SendForm.svelte";
  import ShieldForm from "$lib/components/ShieldForm.svelte";
  import { sdk } from "@repo/contracts/sdk";
  import {
    IERC20__factory,
    MockERC20__factory,
  } from "@repo/contracts/typechain-types";
  import { Ui } from "@repo/ui";
  import { utils } from "@repo/utils";
  import { createQuery } from "@tanstack/svelte-query";
  import { CurrencyAmount, Token } from "@uniswap/sdk-core";

  const balances = $derived(
    createQuery(
      {
        queryKey: ["balances", lib.currencyList.currencies, lib.evm.address],
        queryFn: async () => {
          const address = lib.evm.address;
          if (!address) {
            return [];
          }
          const balances = await Promise.all(
            lib.currencyList.currencies.map(async (token) => {
              const tokenContract = IERC20__factory.connect(
                token.address,
                lib.evm.provider,
              );
              const balance = await tokenContract.balanceOf(address);
              return CurrencyAmount.fromRawAmount(token, balance.toString());
            }),
          );
          return balances;
        },
      },
      lib.queries.queryClient,
    ),
  );

  const shieldedBalances = $derived(
    createQuery(
      {
        queryKey: [
          "shieldedBalances",
          lib.currencyList.currencies,
          lib.evm.address,
        ],
        queryFn: async () => {
          const signer = await lib.evm.getSigner();
          if (!signer) {
            return [];
          }
          const secretKey = await lib.evm.getSecretKey(signer);
          const balances = await Promise.all(
            lib.currencyList.currencies.map(async (token) => {
              const [balanceRaw, notesRaw] = await lib.poolErc20.balanceOfNew(
                token.address,
                secretKey,
              );
              const balance = CurrencyAmount.fromRawAmount(
                token,
                balanceRaw.toString(),
              );
              const fractions = notesRaw.map((note) =>
                CurrencyAmount.fromRawAmount(
                  token,
                  note.amount.amount.toString(),
                ),
              );
              return { balance, fractions };
            }),
          );
          return balances;
        },
      },
      lib.queries.queryClient,
    ),
  );

  const waAddress = $derived(
    createQuery(
      {
        queryKey: ["waAddress", lib.evm.address],
        queryFn: async () => {
          const signer = await lib.evm.getSigner();
          if (!signer) {
            return null;
          }
          const secretKey = await lib.evm.getSecretKey(signer);
          return (
            await sdk.CompleteWaAddress.fromSecretKey(secretKey)
          ).toString();
        },
      },
      lib.queries.queryClient,
    ),
  );
</script>

<Ui.GapContainer class="container">
  <section>
    <div class="prose mb-2">
      <h2>App</h2>
    </div>
  </section>

  <Ui.Card.Root>
    <Ui.Card.Header>
      <Ui.Card.Title>Balances</Ui.Card.Title>
    </Ui.Card.Header>
    <Ui.Card.Content>
      <div>
        Private address:
        <Ui.Query query={$waAddress}>
          {#snippet success(data)}
            {#if data}
              {utils.shortAddress(data)}
              <Ui.CopyButton text={data} variant="ghost" size="icon" />
            {/if}
          {/snippet}
        </Ui.Query>
      </div>

      <Ui.Query query={$balances}>
        {#snippet success(data)}
          {@render balancesBlock(data)}
        {/snippet}
      </Ui.Query>

      <Ui.LoadingButton
        onclick={async () => {
          utils.assertConnected(lib.evm.address);
          for (const token of lib.currencyList.currencies) {
            const contract = MockERC20__factory.connect(
              token.address,
              lib.relayer,
            );
            let tx;
            if (lib.chainId === 31337) {
              tx = await contract.mintForTests(lib.evm.address, 10000000n);
            } else {
              const whaleAddress = "0x40ebc1ac8d4fedd2e144b75fe9c0420be82750c6";
              await lib.provider.send("anvil_impersonateAccount", [
                whaleAddress,
              ]);
              const whale = await lib.provider.getSigner(whaleAddress);
              tx = await contract
                .connect(whale)
                .transfer(
                  lib.evm.address,
                  utils.parseCurrencyAmount(token, "10").quotient.toString(),
                );
            }

            await tx.wait();
            lib.queries.invalidateAll();
          }
        }}
      >
        Mint public tokens
      </Ui.LoadingButton>
    </Ui.Card.Content>
  </Ui.Card.Root>

  <Ui.Card.Root>
    <Ui.Card.Header>
      <Ui.Card.Title>Shielded Balances</Ui.Card.Title>
    </Ui.Card.Header>

    <Ui.Card.Content>
      <Ui.Query query={$shieldedBalances}>
        {#snippet success(data)}
          <!-- {@render balancesBlock(data)} -->
          <div class="flex flex-col gap-2">
            {#each data as balance}
              <div>
                {balance.balance.currency.symbol}
                <span class="font-bold">{balance.balance.toExact()}</span>
                {#if balance.fractions.length > 1}
                  {#each balance.fractions as fraction, i}
                    {#if i > 0}
                      +
                    {/if}
                    ({fraction.toExact()})
                  {/each}
                {/if}
              </div>
            {/each}
          </div>
        {/snippet}
      </Ui.Query>

      <ShieldForm />
    </Ui.Card.Content>
  </Ui.Card.Root>

  <Ui.Card.Root>
    <Ui.Card.Header>
      <Ui.Card.Title>Send</Ui.Card.Title>
    </Ui.Card.Header>

    <Ui.Card.Content>
      <SendForm />
    </Ui.Card.Content>
  </Ui.Card.Root>
</Ui.GapContainer>

{#snippet balancesBlock(data: CurrencyAmount<Token>[])}
  <div class="flex flex-col gap-2">
    {#each data as balance}
      <div>
        {balance.currency.symbol}
        <span class="font-bold">
          {balance.toExact()}
        </span>
      </div>
    {/each}
  </div>
{/snippet}
