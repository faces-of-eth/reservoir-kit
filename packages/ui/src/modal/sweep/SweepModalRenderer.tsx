import React, {
  FC,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import {
  useChainCurrency,
  useCollections,
  usePaymentTokens,
  useReservoirClient,
  useTokens,
} from '../../hooks'
import { useAccount, useWalletClient } from 'wagmi'
import {
  BuyPath,
  Execute,
  LogLevel,
  ReservoirChain,
  ReservoirClientActions,
} from '@reservoir0x/reservoir-sdk'
import { Address, WalletClient, formatUnits, zeroAddress } from 'viem'
import { EnhancedCurrency } from '../../hooks/usePaymentTokens'
import { getNetwork, switchNetwork } from 'wagmi/actions'
import * as allChains from 'viem/chains'
import {
  customChains,
  ReservoirWallet,
  BuyResponses,
} from '@reservoir0x/reservoir-sdk'
import { ProviderOptionsContext } from '../../ReservoirKitProvider'

export enum SweepStep {
  Idle,
  SelectPayment,
  Approving,
  Finalizing,
  Complete,
}

export type SweepModalStepData = {
  totalSteps: number
  stepProgress: number
  currentStep: Execute['steps'][0]
  currentStepItem: NonNullable<Execute['steps'][0]['items']>[0]
  path: Execute['path']
}

type BuyTokenOptions = Parameters<
  ReservoirClientActions['buyToken']
>['0']['options']

export type ChildrenProps = {
  collection?: NonNullable<ReturnType<typeof useCollections>['data']>[0]
  token?: NonNullable<ReturnType<typeof useTokens>['data']>[0]
  loading: boolean
  orders: NonNullable<BuyPath>
  selectedTokens: NonNullable<BuyPath>
  setSelectedTokens: React.Dispatch<React.SetStateAction<NonNullable<BuyPath>>>
  itemAmount: number
  setItemAmount: React.Dispatch<React.SetStateAction<number>>
  maxItemAmount: number
  setMaxItemAmount: React.Dispatch<React.SetStateAction<number>>
  paymentCurrency?: EnhancedCurrency
  setPaymentCurrency: React.Dispatch<
    React.SetStateAction<EnhancedCurrency | undefined>
  >
  chainCurrency: ReturnType<typeof useChainCurrency>
  paymentTokens: EnhancedCurrency[]
  total: bigint
  totalIncludingFees: bigint
  gasCost: bigint
  feeOnTop: bigint
  feeUsd: string
  usdPrice: number
  usdPriceRaw: bigint
  mintPrice: bigint
  currentChain: ReservoirChain | null | undefined
  address?: string
  balance?: bigint
  isConnected: boolean
  disableJumperLink?: boolean
  hasEnoughCurrency: boolean
  addFundsLink: string
  blockExplorerBaseUrl: string
  transactionError: Error | null | undefined
  stepData: SweepModalStepData | null
  setStepData: React.Dispatch<React.SetStateAction<SweepModalStepData | null>>
  sweepStep: SweepStep
  setSweepStep: React.Dispatch<React.SetStateAction<SweepStep>>
  sweepTokens: () => void
}

type Props = {
  open: boolean
  contract?: string
  collectionId?: string
  token?: string
  onConnectWallet: () => void
  chainId?: number
  defaultQuantity?: number
  feesOnTopBps?: string[] | null
  feesOnTopUsd?: string[] | null
  normalizeRoyalties?: boolean
  children: (props: ChildrenProps) => ReactNode
  walletClient?: ReservoirWallet | WalletClient
  usePermit?: boolean
}

export const SweepModalRenderer: FC<Props> = ({
  open,
  chainId,
  contract,
  collectionId,
  token,
  feesOnTopBps,
  feesOnTopUsd,
  defaultQuantity,
  onConnectWallet,
  normalizeRoyalties,
  children,
  walletClient,
  usePermit,
}) => {
  const client = useReservoirClient()
  const { address } = useAccount()
  const [selectedTokens, setSelectedTokens] = useState<NonNullable<BuyPath>>([])
  const [fetchedInitialOrders, setFetchedInitialOrders] = useState(false)
  const [orders, setOrders] = useState<NonNullable<BuyPath>>([])
  const [itemAmount, setItemAmount] = useState<number>(1)
  const [maxItemAmount, setMaxItemAmount] = useState<number>(1)
  const [sweepStep, setSweepStep] = useState<SweepStep>(SweepStep.Idle)
  const [stepData, setStepData] = useState<SweepModalStepData | null>(null)
  const [transactionError, setTransactionError] = useState<Error | null>()
  const [total, setTotal] = useState(0n)
  const [totalIncludingFees, setTotalIncludingFees] = useState(0n)
  const [gasCost, setGasCost] = useState(0n)

  const [hasEnoughCurrency, setHasEnoughCurrency] = useState(true)
  const [feeOnTop, setFeeOnTop] = useState(0n)

  const currentChain = client?.currentChain()

  const rendererChain = chainId
    ? client?.chains.find(({ id }) => id === chainId) || currentChain
    : currentChain

  const chainCurrency = useChainCurrency(rendererChain?.id)

  const collectionContract =
    contract ?? collectionId?.split(':')?.[0] ?? token?.split(':')?.[0]
  const tokenId = token?.split(':')?.[1]

  const wagmiChain: allChains.Chain | undefined = Object.values({
    ...allChains,
    ...customChains,
  }).find(({ id }) => rendererChain?.id === id)

  const providerOptions = useContext(ProviderOptionsContext)
  const disableJumperLink = providerOptions?.disableJumperLink

  const { data: wagmiWallet } = useWalletClient({ chainId: rendererChain?.id })

  const wallet = walletClient || wagmiWallet

  const blockExplorerBaseUrl =
    wagmiChain?.blockExplorers?.default?.url || 'https://etherscan.io'

  const {
    data: collections,
    mutate: mutateCollection,
    isFetchingPage: isFetchingCollections,
  } = useCollections(
    open && {
      contract: collectionId ? undefined : collectionContract,
      id: collectionId ? collectionId : undefined,
    },
    {},
    rendererChain?.id
  )

  const collection = collections && collections[0] ? collections[0] : undefined

  const is1155 = collection?.contractKind === 'erc1155'
  const isSingleToken1155 = is1155 && collection?.tokenCount === '1'

  const { data: tokens } = useTokens(
    open && (tokenId || isSingleToken1155)
      ? {
          collection: isSingleToken1155 ? collection?.id : undefined,
          tokens: isSingleToken1155
            ? undefined
            : `${collectionContract}:${tokenId}`,
        }
      : undefined,
    {},
    rendererChain?.id
  )

  const tokenData = tokens && tokens[0] ? tokens[0] : undefined

  const [listingCurrency, setListingCurrency] = useState<
    EnhancedCurrency | undefined
  >(undefined)

  const [_paymentCurrency, setPaymentCurrency] = useState<
    EnhancedCurrency | undefined
  >(undefined)

  const paymentTokens = usePaymentTokens(
    open,
    address as Address,
    _paymentCurrency ?? chainCurrency,
    totalIncludingFees,
    rendererChain?.id,
    false,
    false,
    listingCurrency
  )

  const paymentCurrency = paymentTokens?.find(
    (paymentToken) =>
      paymentToken?.address === _paymentCurrency?.address &&
      paymentToken?.chainId === _paymentCurrency?.chainId
  )

  const mintPrice = BigInt(
    (orders?.[0]?.currency?.toLowerCase() !== paymentCurrency?.address
      ? orders?.[0]?.buyInRawQuote
      : orders?.[0]?.totalRawPrice) || 0
  )

  const usdPrice = paymentCurrency?.usdPrice || 0
  const usdPriceRaw = paymentCurrency?.usdPriceRaw || 0n
  const feeUsd = formatUnits(
    feeOnTop * usdPriceRaw,
    (paymentCurrency?.decimals || 18) + 6
  )

  const fetchBuyPath = useCallback(() => {
    if (!client) {
      return
    }

    let options: BuyTokenOptions = {
      partial: true,
      onlyPath: true,
      currency: paymentCurrency?.address,
      currencyChainId: paymentCurrency?.chainId,
    }

    if (normalizeRoyalties !== undefined) {
      options.normalizeRoyalties = normalizeRoyalties
    }

    client?.actions
      .buyToken({
        chainId: rendererChain?.id,
        items: [
          {
            collection:
              token ?? tokenData?.token?.tokenId ? undefined : collection?.id,
            token:
              token ?? tokenData?.token?.tokenId
                ? `${collectionContract}:${
                    tokenId ?? tokenData?.token?.tokenId
                  }`
                : undefined,
            fillType: 'trade',
          },
        ],
        expectedPrice: undefined,
        options,
        wallet: {
          address: async () => {
            return address || zeroAddress
          },
        } as any,
        precheck: true,
        onProgress: () => {},
      })
      .then((rawData) => {
        let data = rawData as BuyResponses

        if ('path' in data) {
          let pathData = data['path']
          setOrders(pathData ?? [])

          const pathOrderQuantity =
            pathData?.reduce(
              (quantity, order) => quantity + (order?.quantity || 1),
              0
            ) || 0
          let totalMaxQuantity = pathOrderQuantity
          if ('maxQuantities' in data && data.maxQuantities?.[0]) {
            if (is1155) {
              totalMaxQuantity = data.maxQuantities.reduce(
                (total, currentQuantity) =>
                  total + Number(currentQuantity.maxQuantity ?? 1),
                0
              )
            } else {
              let maxQuantity = data.maxQuantities?.[0].maxQuantity
              // if value is null/undefined, we don't know max quantity, but simulation succeeed with quantity of 1
              totalMaxQuantity = maxQuantity ? Number(maxQuantity) : 1
            }
          }
          setMaxItemAmount(
            pathOrderQuantity > totalMaxQuantity
              ? totalMaxQuantity
              : pathOrderQuantity
          )
        }
      })
      .catch((err) => {
        setOrders([])
        throw err
      })
      .finally(() => {
        setFetchedInitialOrders(true)
      })
  }, [
    address,
    client,
    wallet,
    rendererChain,
    normalizeRoyalties,
    collectionId,
    tokenData?.token?.tokenId,
    collectionContract,
    collection?.id,
    tokenId,
    paymentCurrency?.address,
    paymentCurrency?.chainId,
    is1155,
  ])

  const fetchBuyPathIfIdle = useCallback(() => {
    if (collection && sweepStep === SweepStep.Idle) {
      fetchBuyPath()
    }
  }, [fetchBuyPath, sweepStep, collection])

  useEffect(() => {
    if (open) {
      fetchBuyPathIfIdle()

      const intervalId = setInterval(fetchBuyPathIfIdle, 60000) // Poll buy api every 1 minute
      return () => clearInterval(intervalId)
    }
  }, [
    client,
    wallet,
    open,
    fetchBuyPathIfIdle,
    tokenId,
    is1155,
    collection,
    paymentCurrency?.address,
  ])

  const calculateFees = useCallback(
    (totalPrice: bigint) => {
      let fees = 0n
      if (feesOnTopBps && feesOnTopBps.length > 0) {
        fees = feesOnTopBps.reduce((totalFees, feeOnTop) => {
          const [_, fee] = feeOnTop.split(':')
          return totalFees + (BigInt(fee) * totalPrice) / 10000n
        }, 0n)
      } else if (feesOnTopUsd && feesOnTopUsd.length > 0 && usdPriceRaw) {
        fees = feesOnTopUsd.reduce((totalFees, feeOnTop) => {
          const [_, fee] = feeOnTop.split(':')
          const atomicFee = BigInt(fee)
          const convertedAtomicFee =
            atomicFee * BigInt(10 ** paymentCurrency?.decimals!)
          const currencyFee = convertedAtomicFee / usdPriceRaw
          const parsedFee = formatUnits(currencyFee, 0)
          return totalFees + BigInt(parsedFee)
        }, 0n)
      }

      return fees
    },
    [feesOnTopBps, feeOnTop, usdPriceRaw, feesOnTopUsd, paymentCurrency]
  )

  useEffect(() => {
    let updatedTotal = 0n
    let gasCost = 0n

    // Sweep erc1155
    if (is1155) {
      let remainingQuantity = itemAmount

      for (const order of orders) {
        if (remainingQuantity <= 0) {
          break
        }
        let orderQuantity = order?.quantity || 1
        let orderPricePerItem = BigInt(
          (order?.currency?.toLowerCase() !== paymentCurrency?.address
            ? order?.buyInRawQuote
            : order?.totalRawPrice) || 0
        )

        if (remainingQuantity >= orderQuantity) {
          updatedTotal += orderPricePerItem * BigInt(orderQuantity)
          remainingQuantity -= orderQuantity
        } else {
          let fractionalPrice = orderPricePerItem * BigInt(remainingQuantity)
          updatedTotal += fractionalPrice
          remainingQuantity = 0
        }
        gasCost += BigInt(order.gasCost || 0n)
      }
    }
    // Sweep erc721
    else {
      selectedTokens?.forEach((token) => {
        updatedTotal += BigInt(
          token?.currency?.toLowerCase() != paymentCurrency?.address
            ? token?.buyInRawQuote || 0
            : token?.totalRawPrice || 0
        )
        gasCost += BigInt(token.gasCost || 0n)
      }, 0n)
    }
    const fees = calculateFees(updatedTotal)
    setFeeOnTop(fees)
    setTotal(updatedTotal)
    setTotalIncludingFees(updatedTotal + fees)
    setGasCost(gasCost)
  }, [
    selectedTokens,
    paymentCurrency,
    feesOnTopBps,
    feesOnTopUsd,
    itemAmount,
    orders,
  ])

  // Set paymentCurrency to first paymentToken
  useEffect(() => {
    if (paymentTokens[0] && listingCurrency && !paymentCurrency) {
      setPaymentCurrency(paymentTokens[0])
    }
  }, [paymentTokens, listingCurrency, paymentCurrency])

  // Set listing currency
  useEffect(() => {
    if (listingCurrency || !open || !fetchedInitialOrders) {
      return
    } else if (selectedTokens[0]) {
      setListingCurrency({
        address: selectedTokens?.[0].currency as Address,
        decimals: selectedTokens?.[0].currencyDecimals || 18,
        symbol: selectedTokens?.[0].currencySymbol || '',
        name: selectedTokens?.[0].currencySymbol || '',
        chainId: selectedTokens?.[0].fromChainId ?? rendererChain?.id ?? 1,
      })
    }
  }, [
    listingCurrency,
    open,
    fetchedInitialOrders,
    selectedTokens,
    rendererChain,
  ])

  const addFundsLink = paymentCurrency?.address
    ? `https://jumper.exchange/?toChain=${rendererChain?.id}&toToken=${paymentCurrency?.address}`
    : `https://jumper.exchange/?toChain=${rendererChain?.id}`

  // Determine if user has enough funds in paymentToken
  useEffect(() => {
    if (
      paymentCurrency?.balance != undefined &&
      paymentCurrency?.currencyTotalRaw != undefined &&
      BigInt(paymentCurrency?.balance) <
        paymentCurrency?.currencyTotalRaw + gasCost
    ) {
      setHasEnoughCurrency(false)
    } else {
      setHasEnoughCurrency(true)
    }
  }, [total, paymentCurrency, gasCost])

  useEffect(() => {
    let updatedTokens = []
    let quantity = 0
    for (var i = 0; i < orders.length; i++) {
      const order = orders[i]
      if (order.quantity && order.quantity > 1) {
        quantity += order.quantity
      } else {
        quantity++
      }
      updatedTokens.push(order)
      if (quantity >= itemAmount) {
        break
      }
    }
    setSelectedTokens(updatedTokens)
  }, [itemAmount, maxItemAmount, orders])

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setSelectedTokens([])
      setOrders([])
      setItemAmount(1)
      setMaxItemAmount(1)
      setSweepStep(SweepStep.Idle)
      setTransactionError(null)
      setFetchedInitialOrders(false)
      setPaymentCurrency(undefined)
      setListingCurrency(undefined)
      setStepData(null)
    } else {
      setItemAmount(defaultQuantity || 1)
    }
  }, [open])

  useEffect(() => {
    if (maxItemAmount > 0 && itemAmount > maxItemAmount) {
      setItemAmount(maxItemAmount)
    }
  }, [maxItemAmount, itemAmount])

  const sweepTokens = useCallback(async () => {
    if (!wallet) {
      onConnectWallet()
      if (document.body.style) {
        document.body.style.pointerEvents = 'auto'
      }
      client?.log(['Missing wallet, prompting connection'], LogLevel.Verbose)
      return
    }

    let activeWalletChain = getNetwork().chain
    if (
      activeWalletChain &&
      paymentCurrency?.chainId !== activeWalletChain?.id
    ) {
      activeWalletChain = await switchNetwork({
        chainId: paymentCurrency?.chainId as number,
      })
    }
    if (paymentCurrency?.chainId !== activeWalletChain?.id) {
      const error = new Error(`Mismatching chainIds`)
      setTransactionError(error)
      throw error
    }

    if (!client) {
      const error = new Error('ReservoirClient was not initialized')
      setTransactionError(error)
      throw error
    }

    setTransactionError(null)
    let options: BuyTokenOptions = {
      partial: true,
      currency: paymentCurrency?.address,
      currencyChainId: paymentCurrency?.chainId,
    }

    if (feesOnTopBps && feesOnTopBps?.length > 0) {
      const fixedFees = feesOnTopBps.map((fullFee) => {
        const [referrer, feeBps] = fullFee.split(':')
        const totalFeeTruncated = totalIncludingFees - feeOnTop

        const fee = Math.floor(
          Number(totalFeeTruncated * BigInt(feeBps)) / 10000
        )
        const atomicUnitsFee = formatUnits(BigInt(fee), 0)
        return `${referrer}:${atomicUnitsFee}`
      })
      options.feesOnTop = fixedFees
    } else if (feesOnTopUsd && feesOnTopUsd.length > 0 && usdPriceRaw) {
      const feesOnTopFixed = feesOnTopUsd.map((feeOnTop) => {
        const [recipient, fee] = feeOnTop.split(':')
        const atomicFee = BigInt(fee)
        const convertedAtomicFee =
          atomicFee * BigInt(10 ** paymentCurrency?.decimals!)
        const currencyFee = convertedAtomicFee / usdPriceRaw
        const parsedFee = formatUnits(currencyFee, 0)
        return `${recipient}:${parsedFee}`
      })
      options.feesOnTop = feesOnTopFixed
    } else if (!feesOnTopUsd && !feesOnTopBps) {
      delete options.feesOnTop
    }

    if (normalizeRoyalties !== undefined) {
      options.normalizeRoyalties = normalizeRoyalties
    }

    if (usePermit) {
      options.usePermit = true
    }

    setSweepStep(SweepStep.Approving)

    client.actions
      .buyToken({
        chainId: rendererChain?.id,
        items: [
          {
            collection: tokenData?.token?.tokenId ? undefined : collection?.id,
            token: tokenData?.token?.tokenId
              ? `${collectionContract}:${tokenData?.token?.tokenId}`
              : undefined,
            quantity: itemAmount,
            fillType: 'trade',
          },
        ],
        expectedPrice: {
          [paymentCurrency?.address || zeroAddress]: {
            raw: total,
            currencyAddress: paymentCurrency?.address,
            currencyDecimals: paymentCurrency?.decimals || 18,
          },
        },
        wallet,
        options,
        onProgress: (steps: Execute['steps'], path: Execute['path']) => {
          if (!steps) {
            return
          }

          const executableSteps = steps.filter(
            (step) => step.items && step.items.length > 0
          )

          let stepCount = executableSteps.length

          let currentStepItem:
            | NonNullable<Execute['steps'][0]['items']>[0]
            | undefined

          const currentStepIndex = executableSteps.findIndex((step) => {
            currentStepItem = step.items?.find(
              (item) => item.status === 'incomplete'
            )
            return currentStepItem
          })

          const currentStep =
            currentStepIndex > -1
              ? executableSteps[currentStepIndex]
              : executableSteps[stepCount - 1]

          if (currentStepItem) {
            setStepData({
              totalSteps: stepCount,
              stepProgress: currentStepIndex,
              currentStep,
              currentStepItem,
              path: path,
            })
          }

          if (
            currentStepIndex + 1 === executableSteps.length &&
            currentStep?.items?.every((item) => item.txHashes)
          ) {
            setSweepStep(SweepStep.Finalizing)
          }

          if (
            steps.every(
              (step) =>
                !step.items ||
                step.items.length == 0 ||
                step.items?.every((item) => item.status === 'complete')
            )
          ) {
            setSweepStep(SweepStep.Complete)
          }
        },
      })
      .catch((error: Error) => {
        setTransactionError(error)
        setSweepStep(SweepStep.Idle)
        mutateCollection()
        fetchBuyPath()
      })
  }, [
    selectedTokens,
    client,
    wallet,
    address,
    total,
    totalIncludingFees,
    normalizeRoyalties,
    wagmiChain,
    rendererChain,
    collectionId,
    collection?.id,
    tokenId,
    feesOnTopBps,
    onConnectWallet,
    feesOnTopUsd,
    itemAmount,
    tokenData?.token?.tokenId,
    collectionContract,
    paymentCurrency?.address,
    paymentCurrency?.chainId,
    usePermit,
  ])

  return (
    <>
      {children({
        collection,
        token: tokenData,
        loading:
          isFetchingCollections ||
          (!isFetchingCollections && collection && !fetchedInitialOrders) ||
          ((token !== undefined || isSingleToken1155) && !tokenData) ||
          !(paymentTokens.length > 0),
        address: address,
        selectedTokens,
        setSelectedTokens,
        itemAmount,
        setItemAmount,
        maxItemAmount,
        setMaxItemAmount,
        paymentCurrency,
        setPaymentCurrency,
        chainCurrency,
        paymentTokens,
        total,
        totalIncludingFees,
        gasCost,
        feeOnTop,
        feeUsd,
        usdPrice,
        disableJumperLink,
        usdPriceRaw,
        isConnected: wallet !== undefined,
        currentChain,
        mintPrice,
        orders,
        balance: paymentCurrency?.balance
          ? BigInt(paymentCurrency.balance)
          : undefined,
        hasEnoughCurrency,
        addFundsLink,
        blockExplorerBaseUrl,
        transactionError,
        stepData,
        setStepData,
        sweepStep,
        setSweepStep,
        sweepTokens,
      })}
    </>
  )
}
