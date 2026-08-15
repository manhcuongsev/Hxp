// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST ONLY. Never deploy this.
///
/// On Arc, the native balance and the USDC ERC-20 balance are two views of the *same* funds
/// (18 decimals native, 6 decimals ERC-20). No standard EVM can reproduce that, and `anvil`
/// runs a standard EVM — so a contract there receives `msg.value` as ether that its USDC
/// balance knows nothing about.
///
/// The integration test bridges the gap from the outside: after every payable call it mints
/// this mock to the receiving contract in the exact amount that arrived, `msg.value / 1e12`.
/// That reproduces Arc's invariant — value received natively is simultaneously spendable as
/// USDC — without production code having to know it is being tested.
///
/// What this therefore does NOT cover, and only a live Arc RPC can:
///   * blocklist enforcement reverting transfers at runtime
///   * the real precompile's rounding at the 6/18-decimal boundary
///   * zero-address and burn restrictions on native value
contract MockArcUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "allowance");
            allowance[from][msg.sender] = a - value;
        }
        return _move(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private returns (bool) {
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }

    receive() external payable {}
}
