// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.23;

import {Fr, FrLib} from "./Fr.sol";
import {IVerifier, NoteInput, PublicInputs, AppendOnlyTreeSnapshot} from "./Utils.sol";

// Note: keep in sync with other languages
uint32 constant MAX_NOTES_PER_ROLLUP = 64;
// Note: keep in sync with other languages
uint32 constant MAX_NULLIFIERS_PER_ROLLUP = 64;

struct PendingTx {
    bool rolledUp;
    // TODO(perf): store a hash of the noteHashes and nullifiers and check when rolling up
    Fr[] noteHashes;
    Fr[] nullifiers;
}

contract PoolGeneric {
    using FrLib for Fr;
    using PublicInputs for PublicInputs.Type;

    error TxAlreadyRolledUp(uint256 txIndex);

    struct PoolGenericStorage {
        IVerifier rollupVerifier;
        PendingTx[] allPendingTxs;
        AppendOnlyTreeSnapshot noteHashTree;
        uint256 noteHashBatchIndex;
        AppendOnlyTreeSnapshot nullifierTree;
        uint256 nullifierBatchIndex;
    }

    // TODO(perf): emit only the ciphertext
    event EncryptedNotes(NoteInput[] encryptedNotes);

    // TODO(perf): use dynamic array to save on gas costs
    event NoteHashes(
        uint256 indexed index,
        Fr[MAX_NOTES_PER_ROLLUP] noteHashes
    );

    // TODO(perf): use dynamic array to save on gas costs
    event Nullifiers(
        uint256 indexed index,
        Fr[MAX_NULLIFIERS_PER_ROLLUP] nullifiers
    );

    constructor(IVerifier rollupVerifier_) {
        _poolGenericStorage().rollupVerifier = rollupVerifier_;

        _poolGenericStorage()
            .noteHashTree
            .root = 0x1fd848aa69e1633722fe249a5b7f53b094f1c9cef9f5c694b073fd1cc5850dfb; // empty tree
        _poolGenericStorage()
            .nullifierTree
            .root = 0x2767ce7e247423302eb0ea55fd0aa14294d1b2e9914bce677373d932c0bd1b75; // nullifier tree filled with 1 canonical subtree of nullifiers
        _poolGenericStorage()
            .nullifierTree
            .nextAvailableLeafIndex = MAX_NULLIFIERS_PER_ROLLUP;
    }

    function rollup(
        bytes calldata proof,
        uint256[] calldata txIndices,
        AppendOnlyTreeSnapshot calldata newNoteHashTree,
        AppendOnlyTreeSnapshot calldata newNullifierTree
    ) external {
        Fr[MAX_NOTES_PER_ROLLUP] memory pendingNoteHashes;
        Fr[MAX_NULLIFIERS_PER_ROLLUP] memory pendingNullifiers;
        {
            uint256 noteHashesIdx = 0;
            uint256 nullifiersIdx = 0;
            for (uint256 i = 0; i < txIndices.length; i++) {
                PendingTx memory pendingTx = _poolGenericStorage()
                    .allPendingTxs[txIndices[i]];
                for (uint256 j = 0; j < pendingTx.noteHashes.length; j++) {
                    pendingNoteHashes[noteHashesIdx++] = pendingTx.noteHashes[
                        j
                    ];
                }
                for (uint256 j = 0; j < pendingTx.nullifiers.length; j++) {
                    pendingNullifiers[nullifiersIdx++] = pendingTx.nullifiers[
                        j
                    ];
                }
            }
        }

        PublicInputs.Type memory pi = PublicInputs.create(
            (MAX_NOTES_PER_ROLLUP + 4) + (MAX_NULLIFIERS_PER_ROLLUP + 4)
        );
        // note hashes
        for (uint256 i = 0; i < pendingNoteHashes.length; i++) {
            pi.push(pendingNoteHashes[i].toBytes32());
        }
        pi.push(_poolGenericStorage().noteHashTree.root);
        pi.push(
            uint256(_poolGenericStorage().noteHashTree.nextAvailableLeafIndex)
        );
        pi.push(newNoteHashTree.root);
        pi.push(uint256(newNoteHashTree.nextAvailableLeafIndex));

        // nullifiers
        for (uint256 i = 0; i < pendingNullifiers.length; i++) {
            pi.push(pendingNullifiers[i].toBytes32());
        }
        pi.push(_poolGenericStorage().nullifierTree.root);
        pi.push(
            uint256(_poolGenericStorage().nullifierTree.nextAvailableLeafIndex)
        );
        pi.push(newNullifierTree.root);
        pi.push(uint256(newNullifierTree.nextAvailableLeafIndex));
        require(
            _poolGenericStorage().rollupVerifier.verify(proof, pi.finish()),
            "Invalid rollup proof"
        );

        // mark as rolled up
        for (uint256 i = 0; i < txIndices.length; i++) {
            uint256 txIndex = txIndices[i];
            require(
                !_poolGenericStorage().allPendingTxs[txIndex].rolledUp,
                TxAlreadyRolledUp(txIndex)
            );
            _poolGenericStorage().allPendingTxs[txIndex].rolledUp = true;
        }

        // state update
        emit NoteHashes(
            _poolGenericStorage().noteHashBatchIndex++,
            pendingNoteHashes
        );
        emit Nullifiers(
            _poolGenericStorage().nullifierBatchIndex++,
            pendingNullifiers
        );
        _poolGenericStorage().noteHashTree = newNoteHashTree;
        _poolGenericStorage().nullifierTree = newNullifierTree;
    }

    /**
     * @dev REQUIREMENT: noteHashes do not exist in the noteHashTree and nullifiers do not exist in the nullifierTree.
     * If they do, the tx will never be rolled up.
     */
    function _PoolGeneric_addPendingTx(
        NoteInput[] memory noteInputs,
        bytes32[] memory nullifiers
    ) internal {
        require(noteInputs.length <= MAX_NOTES_PER_ROLLUP, "too many notes");
        require(
            nullifiers.length <= MAX_NULLIFIERS_PER_ROLLUP,
            "too many nullifiers"
        );

        _poolGenericStorage().allPendingTxs.push();
        PendingTx storage pendingTx = _poolGenericStorage().allPendingTxs[
            _poolGenericStorage().allPendingTxs.length - 1
        ];

        for (uint256 i = 0; i < noteInputs.length; i++) {
            Fr noteHash = FrLib.tryFrom(noteInputs[i].noteHash);
            // TODO(perf): this is a waste of gas
            pendingTx.noteHashes.push(noteHash);
        }

        for (uint256 i = 0; i < nullifiers.length; i++) {
            Fr nullifier = FrLib.tryFrom(nullifiers[i]);
            // TODO(perf): this is a waste of gas
            pendingTx.nullifiers.push(nullifier);
        }

        emit EncryptedNotes(noteInputs);
    }

    function getAllPendingTxs() external view returns (PendingTx[] memory) {
        return _poolGenericStorage().allPendingTxs;
    }

    function getNoteHashTree()
        public
        view
        returns (AppendOnlyTreeSnapshot memory)
    {
        return _poolGenericStorage().noteHashTree;
    }

    function getNullifierTree()
        public
        view
        returns (AppendOnlyTreeSnapshot memory)
    {
        return _poolGenericStorage().nullifierTree;
    }

    function _poolGenericStorage()
        private
        pure
        returns (PoolGenericStorage storage s)
    {
        assembly {
            s.slot := STORAGE_SLOT
        }
    }
}

// keccak256("storage.PoolGeneric") - 1
bytes32 constant STORAGE_SLOT = 0x09da1568b6ec0e15d0b57cf3c57223ce89cd8df517a4a7e116dc5a1712234cc2;
