// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Fixed-supply ERC-20. The entire supply is minted once, to the curve, at
///         construction. There is no mint function, no owner, and no upgrade path —
///         after deployment nobody, including Hexapus, can change the supply.
contract HexaToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    /// @dev Arc reverts value transfers to the zero address, so mirroring that rule here
    ///      keeps token behaviour consistent with the chain's own native asset.
    error ZeroAddress();

    constructor(string memory _name, string memory _symbol, uint256 _supply, address _mintTo) {
        name = _name;
        symbol = _symbol;
        totalSupply = _supply;
        balanceOf[_mintTo] = _supply;
        emit Transfer(address(0), _mintTo, _supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        return _transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }
}
