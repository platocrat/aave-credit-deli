import fetch from 'node-fetch'
import { expect } from "chai"
import hre from 'hardhat'
import { Signer } from 'ethers'
import { BigNumber } from '@ethersproject/bignumber'
import { Contract } from '@ethersproject/contracts'
import { JsonRpcSigner } from '@ethersproject/providers'

import { Dai } from '../contract-types/Dai'
import { AToken } from '../contract-types/AToken'

const ETH_URL: string = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'

// Used to later compute ether and wei amounts to the current price of usd.
async function getEtherPrice(_url: string) {
  const json: any = (await fetch(_url)).json()
  return json
}

describe('AaveCreditDelegationV2', () => {
  let aaveCreditDelegationV2: Contract,
    delegator: string, // == contract creator
    delegate: string, // == approved borrower
    contractOwner: string,
    depositorSigner: JsonRpcSigner,
    borrowerSigner: JsonRpcSigner,
    ownerSigner: JsonRpcSigner,
    dai: Dai,
    aDai: AToken,
    currentEthPriceInUSD: number,
    fiveEtherInUSD: number

  const mintAmount: number = 10_000 // in USD
  const depositAmount: number = 2_000 // in USD
  // The deposit-asset 
  const daiAddress: string = '0x6b175474e89094c44da98b954eedeac495271d0f'
  // The interest bearing asset, received 
  const aDaiAddress: string = '0x028171bCA77440897B824Ca71D1c56caC55b68A3'
  // Used to get the balance of the lending pool
  const lendingPoolAddress: string = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9'

  function amountToEther(_amount: number) {
    const amountInEther: number = _amount / currentEthPriceInUSD
    return amountInEther
  }

  function amountToWei(_amount: number) {
    const amountInWei: BigNumber = hre.ethers.utils.parseEther(
      amountToEther(_amount).toString()
    )
    return amountInWei
  }

  before(async () => {
    // Prepare DAI contract interface for CD contract 
    const signer: JsonRpcSigner = hre.ethers.provider.getSigner(0);

    [delegator, delegate, contractOwner] = await hre.ethers.provider.listAccounts()

    depositorSigner = hre.ethers.provider.getSigner(delegator)
    borrowerSigner = hre.ethers.provider.getSigner(delegate)
    ownerSigner = hre.ethers.provider.getSigner(contractOwner)

    currentEthPriceInUSD = (await getEtherPrice(ETH_URL)).ethereum.usd,
      fiveEtherInUSD = 5.0 * currentEthPriceInUSD

    signer.sendTransaction({
      to: delegator,
      value: hre.ethers.utils.parseEther('1')
    })

    await hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [delegator]
    })

    dai = await hre.ethers.getContractAt('IERC20', daiAddress) as Dai
    aDai = await hre.ethers.getContractAt('IERC20', aDaiAddress) as AToken

    const aaveCreditDelegationV2Address: string = hre
      .ethers.utils.getContractAddress({
        from: delegator,
        nonce: (await hre.ethers.provider.getTransactionCount(delegator)) + 1
      })

    // Approve credit delegation contract for transfers later
    await dai.approve(
      aaveCreditDelegationV2Address,
      hre.ethers.utils.parseEther('100')
    )

    // Create CD contract
    const AaveCreditDelegationV2 = await hre.ethers.getContractFactory(
      'AaveCreditDelegationV2'
    )

    aaveCreditDelegationV2 = await AaveCreditDelegationV2.deploy()
    await aaveCreditDelegationV2.deployed()
  })

  /** 
   * @notice PASSES 
   */
  describe("deposit collateral with delegator's funds", async () => {
    let balanceBefore: BigNumber,
      cdContract_aDaiBalanceBefore: BigNumber,
      delegatorBalanceBefore: BigNumber,
      balanceBeforeInEther: string,
      cdContract_aDaiBalanceBeforeInEther: string,
      delegatorBalanceBeforeInEther: string,
      canPullFundsFromDelegator: boolean,
      canPullFundsFromDelegate: boolean,
      assetToBorrow: string, // address
      amountToBorrowInWei: BigNumber,
      // Must be of the same type as the debt token that is delegated, i.e. 
      // stable = 1, variable = 2.
      interestRateMode: number,
      // To be implemented later (used for early supportive projects to the Aave
      // ecosystem). If there is no referral code, use `0`.
      referralCode: number

    function setCanPullFundsFromDelegator(_canPull: boolean) {
      canPullFundsFromDelegator = _canPull
    }

    function setCanPullFundsFromDelegate(_canPull: boolean) {
      canPullFundsFromDelegate = _canPull
    }

    before(async () => {
      // DAI balances in wei
      balanceBefore = await dai.balanceOf(delegator),
        delegatorBalanceBefore = await dai.balanceOf(delegator),
        // DAI balances in ether
        balanceBeforeInEther = hre
          .ethers.utils.formatUnits(balanceBefore, 'ether'),
        delegatorBalanceBeforeInEther = hre
          .ethers.utils.formatUnits(delegatorBalanceBefore, 'ether'),
        // aDAI balance in wei
        cdContract_aDaiBalanceBefore = await aDai.balanceOf(
          aaveCreditDelegationV2.address
        ),
        // aDAI balance in ether
        cdContract_aDaiBalanceBeforeInEther = hre
          .ethers.utils.formatUnits(cdContract_aDaiBalanceBefore, 'ether'),
        // Amount to borrow == 1,000 DAI
        amountToBorrowInWei = amountToWei(depositAmount * 0.5)
    })

    /** @notice PASSES */
    it('delegator should hold 5.0 ether worth of DAI before deposit', async () => {
      const balanceInUSD: number =
        parseFloat(balanceBeforeInEther) * currentEthPriceInUSD

      expect(balanceInUSD).to.eq(fiveEtherInUSD)
    })

    /** 
     * @notice PASSES 
     */
    it('delegator should have 2,000 less DAI after depositing collateral', async () => {
      // 1. Delegator approves this contract to pull funds from his/her account.
      setCanPullFundsFromDelegator(true)


      // 2. Delegator then deposits collateral into Aave lending pool.
      await aaveCreditDelegationV2.connect(depositorSigner).depositCollateral(
        daiAddress,
        amountToWei(depositAmount),
        canPullFundsFromDelegator
      )

      const balanceAfter: BigNumber = await dai.balanceOf(delegator)
      const balanceAfterInEther: string = hre
        .ethers.utils.formatUnits(balanceAfter.toString(), 'ether')
      const diff: number =
        parseFloat(balanceBeforeInEther) - parseFloat(balanceAfterInEther)

      expect(
        diff.toFixed(4)
      ).to.eq(
        amountToEther(depositAmount).toFixed(4)
      )
    })

    /** 
     * @notice PASSES
     */
    it('CD contract should now hold 2000 aDAI', async () => {
      const newContractBalanceString = (await aDai.balanceOf(
        aaveCreditDelegationV2.address)
      ).toString()
      const newContractBalanceInUSD = parseFloat(hre.ethers.utils.formatUnits(
        newContractBalanceString,
        'ether'
      ))
      const diff: number = (
        newContractBalanceInUSD - parseFloat(cdContract_aDaiBalanceBeforeInEther)
      ) * currentEthPriceInUSD
      const assertionBalance: number = 2000

      expect(diff.toFixed(4)).to.eq(assertionBalance.toFixed(4))
    })

    /** 
     * @notice PASSES 
     */
    it("delegate should borrow 50% of delegator's deposit amount from lending pool", async () => {
      assetToBorrow = daiAddress,
        interestRateMode = 1, // using the DAI stablecoin
        referralCode = 0  // no referral code

      const cdContract_DaiBalanceBefore = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )

      // 1. Delegator approves the delegate for a line of credit,
      //    which is a percentage of the delegator's collateral deposit.
      await aaveCreditDelegationV2.connect(depositorSigner).approveBorrower(
        delegate,
        amountToBorrowInWei,
        daiAddress
      )

      // 2. The delegate borrows against the Aave lending pool using the credit
      //    delegated to them by the delegator.
      await aaveCreditDelegationV2.connect(borrowerSigner).borrow(
        assetToBorrow,
        /** @dev Borrowed funds are sent to the CD contract. */
        amountToBorrowInWei,
        interestRateMode,
        referralCode,
        delegator
      )

      const cdContractBalanceAfterBorrow: BigNumber = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )
      const diff: BigNumber = cdContractBalanceAfterBorrow.sub(
        cdContract_DaiBalanceBefore
      )

      expect(diff.toString()).to.eq(amountToBorrowInWei)
    })

    /** 
     * @notice PASSES 
     */
    it("delegate should fully repay borrowed funds using CD contract's funds", async () => {
      // 1. Borrower sets `_canPullFundFromDelegate` to false.
      setCanPullFundsFromDelegate(false)

      const cdContract_DaiBalanceBefore = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )

      const assetToRepay: string = daiAddress
      const repayAmount = amountToBorrowInWei

      // 2. Borrower calls function to repay uncollateralized loan.
      await aaveCreditDelegationV2.connect(borrowerSigner).repayBorrower(
        delegator,
        repayAmount,
        assetToRepay,
        canPullFundsFromDelegate
      )

      const cdContractBalanceAfterRepayment: BigNumber = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )
      const diff: BigNumber = cdContract_DaiBalanceBefore.sub(
        cdContractBalanceAfterRepayment
      )

      expect(diff).to.eq(repayAmount)
    })


    /**
     * @notice PASSES
     */
    it('delegator should withdraw their entire collateral deposit', async () => {
      const assetToWithdraw = daiAddress
      const balanceBefore = await dai.balanceOf(delegator)

      await aaveCreditDelegationV2.connect(depositorSigner).withdrawCollateral(
        assetToWithdraw
      )

      const balanceAfter = await dai.balanceOf(delegator)
      const diff = balanceAfter.sub(balanceBefore)

      expect(diff).to.eq(amountToWei(depositAmount))
    })
  })

  /** 
   * @notice PASSES
   */
  describe("deposit collateral with contract's funds", async () => {
    let balanceBefore: BigNumber,
      cdContract_aDaiBalanceBefore: BigNumber,
      contractDaiBalanceBeforeToSubtract: BigNumber,
      balanceBeforeInEther: string,
      cdContract_aDaiBalanceBeforeInEther: string,
      canPullFundsFromDelegator: boolean,
      canPullFundsFromDelegate: boolean,
      assetToBorrow: string, // address
      // Must be equal to or less than amount delegated.
      amountToBorrowInWei: BigNumber,
      // Must be of the same type as the debt token that is delegated, i.e. 
      // stable = 1, variable = 2.
      interestRateMode: number,
      // To be implemented later (used for early supportive projects to the Aave
      // ecosystem). If there is no referral code, use `0`.
      referralCode: number

    function setCanPullFundsFromDelegator(_canPull: boolean) {
      canPullFundsFromDelegator = _canPull
    }

    function setCanPullFundsFromDelegate(_canPull: boolean) {
      canPullFundsFromDelegate = _canPull
    }

    before(async () => {
      contractDaiBalanceBeforeToSubtract = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )

      // Send 3.0 ether worth of DAI to CD contract
      await dai.transfer(
        aaveCreditDelegationV2.address,
        hre.ethers.utils.parseEther('3')
      )

      // DAI balances in wei
      balanceBefore = await dai.balanceOf(aaveCreditDelegationV2.address),
        // aDAI balance in wei
        cdContract_aDaiBalanceBefore = await aDai.balanceOf(
          aaveCreditDelegationV2.address
        ),
        // DAI balances in ether
        balanceBeforeInEther = hre
          .ethers.utils.formatUnits(balanceBefore, 'ether'),
        // aDAI balance in ether
        cdContract_aDaiBalanceBeforeInEther = hre
          .ethers.utils.formatUnits(cdContract_aDaiBalanceBefore, 'ether'),
        // Amount to borrow == 1,000 DAI
        amountToBorrowInWei = amountToWei(depositAmount * 0.5)
    })

    /** @notice PASSES */
    it('contract should now hold 3.0 ether worth of DAI, after sending DAI to contract', async () => {
      const balanceAfterReceivingDAI: BigNumber = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )
      const threeEther: BigNumber = hre.ethers.utils.parseEther('3')
      const balance: BigNumber = balanceAfterReceivingDAI.sub(
        contractDaiBalanceBeforeToSubtract
      )

      expect(balance).to.equal(threeEther)
    })

    /** @notice PASSES */
    it('contract should have 2,000 less DAI after depositing collateral', async () => {
      // 1. Delegator denies this contract to pull funds from his/her account,
      //    in effect, telling the contract to use funds held within it.
      setCanPullFundsFromDelegator(false)

      // 2. Delegator then clicks `deposit` button
      await aaveCreditDelegationV2.connect(depositorSigner).depositCollateral(
        daiAddress,
        amountToWei(depositAmount),
        canPullFundsFromDelegator
      )

      const balanceAfter: BigNumber = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )
      const balanceAfterInEther: string = hre
        .ethers.utils.formatUnits(balanceAfter.toString(), 'ether')
      const diff: number =
        parseFloat(balanceBeforeInEther) - parseFloat(balanceAfterInEther)

      expect(
        diff.toFixed(4)
      ).to.eq(
        amountToEther(depositAmount).toFixed(4)
      )
    })

    /** @notice PASSES */
    it('CD contract should now hold 2000 aDAI', async () => {
      const newContractBalanceString = (await aDai.balanceOf(
        aaveCreditDelegationV2.address)
      ).toString()
      const newContractBalanceInUSD = parseFloat(hre.ethers.utils.formatUnits(
        newContractBalanceString,
        'ether'
      ))
      const diff: number = (
        newContractBalanceInUSD - parseFloat(cdContract_aDaiBalanceBeforeInEther)
      ) * currentEthPriceInUSD
      const assertionBalance: number = 2000

      expect(diff.toFixed(4)).to.eq(assertionBalance.toFixed(4))
    })

    /** 
     * @notice PASSES 
     */
    it("delegate should borrow 50% of delegator's deposit amount from lending pool", async () => {
      assetToBorrow = daiAddress,
        interestRateMode = 1, // using the DAI stablecoin
        referralCode = 0  // no referral code

      const cdContract_DaiBalanceBefore = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )

      // 1. Delegator approves the delegate for a line of credit,
      //    which is a percentage of the delegator's collateral deposit.
      await aaveCreditDelegationV2.connect(depositorSigner).approveBorrower(
        delegate,
        amountToBorrowInWei,
        daiAddress
      )

      // 2. The delegate borrows against the Aave lending pool using the credit
      //    delegated to them by the delegator.
      await aaveCreditDelegationV2.connect(borrowerSigner).borrow(
        assetToBorrow,
        /** @dev Borrowed funds are sent to the CD contract. */
        amountToBorrowInWei,
        interestRateMode,
        referralCode,
        delegator
      )

      const cdContractBalanceAfterBorrow: BigNumber = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )
      const diff: BigNumber = cdContractBalanceAfterBorrow.sub(
        cdContract_DaiBalanceBefore
      )

      expect(diff.toString()).to.eq(amountToBorrowInWei)
    })

    /** 
     * @notice PASSES 
     */
    it("delegate should fully repay borrowed funds using CD contract's funds", async () => {
      // 1. Borrower sets `_canPullFundFromDelegate` to false.
      setCanPullFundsFromDelegate(false)

      const cdContract_DaiBalanceBefore = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )

      const assetToRepay: string = daiAddress
      const repayAmount = amountToBorrowInWei

      // 2. Borrower calls function to repay uncollateralized loan.
      await aaveCreditDelegationV2.connect(borrowerSigner).repayBorrower(
        delegator,
        repayAmount,
        assetToRepay,
        canPullFundsFromDelegate
      )

      const cdContractBalanceAfterRepayment: BigNumber = await dai.balanceOf(
        aaveCreditDelegationV2.address
      )
      const diff: BigNumber = cdContract_DaiBalanceBefore.sub(
        cdContractBalanceAfterRepayment
      )

      expect(diff).to.eq(repayAmount)
    })


    /**
     * @notice PASSES
     */
    it('delegator should withdraw their entire collateral deposit', async () => {
      const assetToWithdraw = daiAddress
      const balanceBefore = await dai.balanceOf(delegator)

      await aaveCreditDelegationV2.connect(depositorSigner).withdrawCollateral(
        assetToWithdraw
      )

      const balanceAfter = await dai.balanceOf(delegator)
      const diff = balanceAfter.sub(balanceBefore)

      expect(diff).to.eq(amountToWei(depositAmount))
    })
  })
})
