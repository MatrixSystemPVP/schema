import { OPERATION } from "../spec";
import { $changes, $childType, Schema } from "../Schema";
import { FilterChildrenCallback, DefinitionType, PrimitiveType } from "../annotations";

import { MapSchema } from "../types/MapSchema";
import { ArraySchema } from "../types/ArraySchema";
import { CollectionSchema } from "../types/CollectionSchema";
import { SetSchema } from "../types/SetSchema";

import { Encoder, encodePrimitiveType } from "../Encoder";
import * as encode from "../encoding/encode";
import { assertInstanceType } from "../encoding/assert";
import { getType } from "../types/typeRegistry";
import { Metadata } from "../Metadata";

export type Ref = Schema
    | ArraySchema
    | MapSchema
    | CollectionSchema
    | SetSchema;

export interface ChangeOperation {
    op: OPERATION,
    index: number,
}

export class Root {
    changes = new Set<ChangeTracker>();
    protected nextUniqueId: number = 1;

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    enqueue(changeTree: ChangeTracker) {
        this.changes.add(changeTree);
    }

    dequeue(changeTree: ChangeTracker) {
        this.changes.delete(changeTree);
    }

    clear() {
        this.changes.clear();
    }
}

export interface ChangeTracker {
    root?: Root;

    ref: Ref;
    refId: number;

    changed: boolean;
    changes: Map<number, ChangeOperation>;
    allChanges: Set<number>;
    indexes: {[index: string]: any};

    ensureRefId(): void;

    setRoot(root: Root): void;
    setParent(parent: Ref, root?: Root, parentIndex?: number): void;

    change(index: number, operation?: OPERATION): void;
    touch(fieldName: string | number): void;
    delete(fieldName: string | number): void;
    discard(changed?: boolean, discardAll?: boolean): void;
    discardAll(): void;

    getType(index: number): DefinitionType;
    getValue(index: number): any;

    // getChildrenFilter(): FilterChildrenCallback;
    // ensureRefId(): void;
}

export const $encodeOperation = Symbol("$encodeOperation");

export class ChangeTree implements ChangeTracker {
    ref: Ref;
    refId: number;

    root?: Root;

    parent?: Ref;
    parentIndex?: number;

    indexes: {[index: string]: any} = {};

    changed: boolean = false;
    changes = new Map<number, ChangeOperation>();
    allChanges = new Set<number>();

    operations: ChangeOperation[] = [];
    currentCustomOperation: number = 0;

    constructor(ref: Ref) {
        this.ref = ref;
    }

    setRoot(root: Root) {
        this.root = root;
        this.indexes = {};

        root.enqueue(this);

        this.allChanges.forEach((index) => {
            const childRef = (this.ref as Schema)['getByIndex'](index);
            if (childRef && childRef[$changes]) {
                childRef[$changes].setRoot(root);
            }
        });
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        this.parent = parent;
        this.parentIndex = parentIndex;

        // avoid setting parents with empty `root`
        if (!root) { return; }

        this.root = root;
        this.root['enqueue'](this);

        this.ensureRefId();

        //
        // assign same parent on child structures
        //
        if (this.ref instanceof Schema) {
            const metadata = this.ref['constructor'][Symbol.metadata];

            // FIXME: need to iterate over parent metadata instead.
            for (const field in metadata) {
                const value = this.ref[field];

                if (value && value[$changes]) {
                    const parentIndex = Metadata.getIndex(metadata, field);

                    value[$changes].setParent(
                        this.ref,
                        root,
                        parentIndex,
                    );
                }
            }

        } else if (typeof (this.ref) === "object") {
            this.ref.forEach((value, key) => {
                if (value instanceof Schema) {
                    const changeTreee = value[$changes];
                    const parentIndex = this.ref[$changes].indexes[key];

                    changeTreee.setParent(
                        this.ref,
                        this.root,
                        parentIndex,
                    );
                }
            });
        }
    }

    operation(op: ChangeOperation) {
        this.changes.set(--this.currentCustomOperation, op);
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const previousChange = this.changes.get(index);

        if (
            !previousChange ||
            previousChange.op === OPERATION.DELETE ||
            previousChange.op === OPERATION.TOUCH // (mazmorra.io's BattleAction issue)
        ) {
            this.changes.set(index, {
                op: (!previousChange)
                    ? operation
                    : (previousChange.op === OPERATION.DELETE)
                        ? OPERATION.DELETE_AND_ADD
                        : operation,
                        // : OPERATION.REPLACE,
                index
            });
        }

        this.allChanges.add(index);

        this.changed = true;
        // this.touchParents();

        this.root?.enqueue(this);
    }

    touch(fieldName: string | number) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];

        this.assertValidIndex(index, fieldName);

        if (!this.changes.has(index)) {
            this.changes.set(index, { op: OPERATION.TOUCH, index });
        }

        this.allChanges.add(index);

        // ensure touch is placed until the $root is found.
        this.touchParents();
    }

    touchParents() {
        if (this.parent) {
            this.parent[$changes].touch(this.parentIndex);
        }
    }

    getType(index?: number) {
        if (this.ref instanceof Schema) {
            const metadata = this.ref['constructor'][Symbol.metadata] as Metadata;
            return metadata[metadata[index]].type;
        } else {
            //
            // Get the child type from parent structure.
            // - ["string"] => "string"
            // - { map: "string" } => "string"
            // - { set: "string" } => "string"
            //
            return this.ref[$childType];
        }
    }

    getChildrenFilter(): FilterChildrenCallback {
        const childFilters = (this.parent as Schema)['metadata'].childFilters;
        return childFilters && childFilters[this.parentIndex];
    }

    //
    // used during `.encode()`
    //
    getValue(index: number) {
        return this.ref['getByIndex'](index);
        // if (this.ref instanceof Schema) {
        //     return this.ref[this.ref.constructor[Symbol.metadata][index]];

        // } else {
        //     return this.ref['getByIndex'](index);
        // }
    }

    delete(fieldName: string | number) {
        const index = this.indexes[fieldName];

        if (index === undefined) {
            console.warn(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index: ${fieldName} (${index})`);
            return;
        }

        const previousValue = this.getValue(index);

        this.changes.set(index, { op: OPERATION.DELETE, index });

        this.allChanges.delete(index);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            previousValue[$changes].parent = undefined;
            this.root.dequeue(previousValue[$changes]);
        }

        this.changed = true;
        this.touchParents();
    }

    discard(changed: boolean = false, discardAll: boolean = false) {
        //
        // Map, Array, etc:
        // Remove cached key to ensure ADD operations is unsed instead of
        // REPLACE in case same key is used on next patches.
        //
        // TODO: refactor this. this is not relevant for Collection and Set.
        //
        if (!(this.ref instanceof Schema)) {
            this.changes.forEach((change) => {
                if (change.op === OPERATION.DELETE) {
                    const index = this.ref['getIndex'](change.index)
                    delete this.indexes[index];
                }
            });
        }

        this.changes.clear();
        this.changed = changed;

        if (discardAll) {
            this.allChanges.clear();
        }

        // re-set `currentCustomOperation`
        this.currentCustomOperation = 0;
    }

    /**
     * Recursively discard all changes from this, and child structures.
     */
    discardAll() {
        this.changes.forEach((change) => {
            const value = this.getValue(change.index);

            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        });

        this.discard();
    }

    ensureRefId() {
        // skip if refId is already set.
        if (this.refId !== undefined) {
            return;
        }

        this.refId = this.root.getNextUniqueId();
    }

    protected assertValidIndex(index: number, fieldName: string | number) {
        if (index === undefined) {
            throw new Error(`ChangeTree: missing index for field "${fieldName}"`);
        }
    }

}

export class FieldChangeTracker implements ChangeTracker {
    ref: Ref;
    refId: number;

    root?: Root;

    parent?: Ref;
    parentIndex?: number;

    changed: boolean = false;
    changes = new Map<number, ChangeOperation>();

    indexes: { [index: string]: any; };

    allChanges = new Set<number>();

    constructor(ref: Ref) {
        this.ref = ref;
    }

    setRoot(root: Root) {
        this.root = root;

        root.enqueue(this);

        this.allChanges.forEach((index) => {
            const childRef = (this.ref as Schema)['getByIndex'](index);
            if (childRef && childRef[$changes]) {
                childRef[$changes].setRoot(root);
            }
        });
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        this.parent = parent;
        this.parentIndex = parentIndex;

        // avoid setting parents with empty `root`
        if (!root) { return; }

        this.root = root;
        this.root['enqueue'](this);

        this.ensureRefId();

        //
        // assign same parent on child structures
        //
        if (this.ref instanceof Schema) {
            const metadata = this.ref.constructor[Symbol.metadata];

            // FIXME: need to iterate over parent metadata instead.
            for (const field in metadata) {
                const value = this.ref[field];

                if (value && value[$changes]) {
                    const parentIndex = Metadata.getIndex(metadata, field);

                    value[$changes].setParent(
                        this.ref,
                        root,
                        parentIndex,
                    );
                }
            }

        } else if (typeof (this.ref) === "object") {
            this.ref.forEach((value, key) => {
                if (value instanceof Schema) {
                    const changeTreee = value[$changes];
                    const parentIndex = this.ref[$changes].indexes[key];

                    changeTreee.setParent(
                        this.ref,
                        this.root,
                        parentIndex,
                    );
                }
            });
        }
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const previousChange = this.changes.get(index);

        if (
            !previousChange ||
            previousChange.op === OPERATION.DELETE ||
            previousChange.op === OPERATION.TOUCH // (mazmorra.io's BattleAction issue)
        ) {
            this.changes.set(index, {
                op: (!previousChange)
                    ? operation
                    : (previousChange.op === OPERATION.DELETE)
                        ? OPERATION.DELETE_AND_ADD
                        : operation,
                index
            });
        }

        this.allChanges.add(index);

        this.changed = true;

        this.root?.enqueue(this);
    }

    touch(fieldName: string | number) {
        const index = this.ref.constructor[Symbol.metadata][fieldName].index;

        if (!this.changes.has(index)) {
            this.changes.set(index, { op: OPERATION.TOUCH, index });
        }

        this.allChanges.add(index);
    }

    getType(index?: number) {
        const metadata = this.ref.constructor[Symbol.metadata] as Metadata;
        return metadata[metadata[index]].type;
    }

    getChildrenFilter(): FilterChildrenCallback {
        const metadata = this.ref.constructor[Symbol.metadata];
        const childFilters = metadata.childFilters;
        return childFilters && childFilters[this.parentIndex];
    }

    //
    // used during `.encode()`
    //
    getValue(index: number) {
        return this.ref[this.ref.constructor[Symbol.metadata][index]];
    }

    delete(fieldName: string | number) {
        const index = this.ref.constructor[Symbol.metadata][fieldName].index;
        const previousValue = this.getValue(index);

        this.changes.set(index, { op: OPERATION.DELETE, index });
        this.allChanges.delete(index);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            previousValue[$changes].parent = undefined;
            this.root.dequeue(previousValue[$changes]);
        }

        this.changed = true;
    }

    discard(changed: boolean = false, discardAll: boolean = false) {
        this.changes.clear();
        this.changed = changed;

        if (discardAll) {
            this.allChanges.clear();
        }
    }

    /**
     * Recursively discard all changes from this, and child structures.
     */
    discardAll() {
        this.changes.forEach((change) => {
            const value = this.getValue(change.index);

            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        });

        this.discard();
    }

    ensureRefId() {
        // skip if refId is already set.
        if (this.refId !== undefined) {
            return;
        }

        this.refId = this.root.getNextUniqueId();
    }
}

FieldChangeTracker[$encodeOperation] = function (
    encoder: Encoder,
    bytes: number[],
    operation: ChangeOperation,
    changeTree: FieldChangeTracker,
) {
    const ref = changeTree.ref;
    const field = ref['constructor'][Symbol.metadata][operation.index]

    // encode field index + operation
    if (operation.op !== OPERATION.TOUCH) {
        //
        // Compress `fieldIndex` + `operation` into a single byte.
        // This adds a limitaion of 64 fields per Schema structure
        //
        encode.uint8(bytes, (operation.index | operation.op));
    }

    if (operation.op === OPERATION.DELETE) {
        //
        // TODO: delete from filter cache data.
        //
        // if (useFilters) {
        //     delete changeTree.caches[fieldIndex];
        // }
        return;
    }

    // const type = changeTree.childType || ref._schema[field];
    const type = changeTree.getType(operation.index);

    // const type = changeTree.getType(fieldIndex);
    const value = changeTree.getValue(operation.index);

    // ensure refId for the value
    if (value && value[$changes]) {
        value[$changes].ensureRefId();
    }

    if (operation.op === OPERATION.TOUCH) {
        return;
    }

    if (Schema.is(type)) {
        assertInstanceType(value, type as typeof Schema, ref as Schema, field);

        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$changes].refId);

        // Try to encode inherited TYPE_ID if it's an ADD operation.
        if ((operation.op & OPERATION.ADD) === OPERATION.ADD) {
            encoder.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema);
        }

    } else if (typeof(type) === "string") {
        //
        // Primitive values
        //
        encodePrimitiveType(type as PrimitiveType, bytes, value, ref as Schema, field);

    } else {
        //
        // Custom type (MapSchema, ArraySchema, etc)
        //
        const definition = getType(Object.keys(type)[0]);

        //
        // ensure a ArraySchema has been provided
        //
        assertInstanceType(ref[field], definition.constructor, ref as Schema, field);

        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$changes].refId);
    }
}

export class KeyValueChangeTracker implements ChangeTracker {
    ref: Ref;
    refId: number;

    root?: Root;

    parent?: Ref;
    parentIndex?: number;

    indexes: {[index: string]: any} = {};

    changed: boolean = false;
    changes = new Map<number, ChangeOperation>();
    allChanges = new Set<number>();

    operations: ChangeOperation[] = [];
    currentCustomOperation: number = 0;

    constructor(ref: Ref) {
        this.ref = ref;
    }

    setRoot(root: Root) {
        this.root = root;
        this.indexes = {};

        root.enqueue(this);

        this.allChanges.forEach((index) => {
            const childRef = (this.ref as Schema)['getByIndex'](index);
            if (childRef && childRef[$changes]) {
                childRef[$changes].setRoot(root);
            }
        });
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        this.parent = parent;
        this.parentIndex = parentIndex;

        // avoid setting parents with empty `root`
        if (!root) { return; }

        this.root = root;
        this.root['enqueue'](this);

        this.ensureRefId();

        //
        // assign same parent on child structures
        //
        (this.ref as MapSchema).forEach((value, key) => {
            if (value instanceof Schema) {
                const changeTreee = value[$changes];
                const parentIndex = this.ref[$changes].indexes[key];

                changeTreee.setParent(
                    this.ref,
                    this.root,
                    parentIndex,
                );
            }
        });
    }

    operation(op: ChangeOperation) {
        this.changes.set(--this.currentCustomOperation, op);
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const previousChange = this.changes.get(index);

        if (
            !previousChange ||
            previousChange.op === OPERATION.DELETE ||
            previousChange.op === OPERATION.TOUCH // (mazmorra.io's BattleAction issue)
        ) {
            this.changes.set(index, {
                op: (!previousChange)
                    ? operation
                    : (previousChange.op === OPERATION.DELETE)
                        ? OPERATION.DELETE_AND_ADD
                        : operation,
                        // : OPERATION.REPLACE,
                index
            });
        }

        this.allChanges.add(index);

        this.changed = true;
        // this.touchParents();

        this.root?.enqueue(this);
    }

    touch(fieldName: string | number) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];

        this.assertValidIndex(index, fieldName);

        if (!this.changes.has(index)) {
            this.changes.set(index, { op: OPERATION.TOUCH, index });
        }

        this.allChanges.add(index);

        // ensure touch is placed until the $root is found.
        this.touchParents();
    }

    touchParents() {
        if (this.parent) {
            this.parent[$changes].touch(this.parentIndex);
        }
    }

    getType(index?: number) {
        //
        // Get the child type from parent structure.
        // - ["string"] => "string"
        // - { map: "string" } => "string"
        // - { set: "string" } => "string"
        //
        return this.ref[$childType];
    }

    getChildrenFilter(): FilterChildrenCallback {
        const childFilters = (this.parent as Schema)['metadata'].childFilters;
        return childFilters && childFilters[this.parentIndex];
    }

    //
    // used during `.encode()`
    //
    getValue(index: number) {
        if (this.ref instanceof Schema) {
            return this.ref[this.ref.constructor[Symbol.metadata][index]];

        } else {
            return this.ref['getByIndex'](index);
        }
    }

    delete(fieldName: string | number) {
        const index = this.indexes[fieldName];

        if (index === undefined) {
            console.warn(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index: ${fieldName} (${index})`);
            return;
        }

        const previousValue = this.getValue(index);

        this.changes.set(index, { op: OPERATION.DELETE, index });

        this.allChanges.delete(index);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            previousValue[$changes].parent = undefined;
            this.root.dequeue(previousValue[$changes]);
        }

        this.changed = true;
        this.touchParents();
    }

    discard(changed: boolean = false, discardAll: boolean = false) {
        //
        // Map, Array, etc:
        // Remove cached key to ensure ADD operations is unsed instead of
        // REPLACE in case same key is used on next patches.
        //
        // TODO: refactor this. this is not relevant for Collection and Set.
        //
        if (!(this.ref instanceof Schema)) {
            this.changes.forEach((change) => {
                if (change.op === OPERATION.DELETE) {
                    const index = this.ref['getIndex'](change.index)
                    delete this.indexes[index];
                }
            });
        }

        this.changes.clear();
        this.changed = changed;

        if (discardAll) {
            this.allChanges.clear();
        }

        // re-set `currentCustomOperation`
        this.currentCustomOperation = 0;
    }

    /**
     * Recursively discard all changes from this, and child structures.
     */
    discardAll() {
        this.changes.forEach((change) => {
            const value = this.getValue(change.index);

            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        });

        this.discard();
    }

    ensureRefId() {
        // skip if refId is already set.
        if (this.refId !== undefined) {
            return;
        }

        this.refId = this.root.getNextUniqueId();
    }

    protected assertValidIndex(index: number, fieldName: string | number) {
        if (index === undefined) {
            throw new Error(`ChangeTree: missing index for field "${fieldName}"`);
        }
    }

}

KeyValueChangeTracker[$encodeOperation] = function (
    encoder: Encoder,
    bytes: number[],
    operation: ChangeOperation,
    changeTree: FieldChangeTracker,
) {
    const ref = changeTree.ref;
    const fieldIndex = operation.index;

    // encode field index + operation
    if (operation.op !== OPERATION.TOUCH) {
        encode.uint8(bytes, operation.op);

        // custom operations
        if (operation.op === OPERATION.CLEAR) {
            return;
        }

        // indexed operations
        encode.number(bytes, fieldIndex);
    }

    //
    // encode "alias" for dynamic fields (maps)
    // ADD or DELETE_AND_ADD
    //
    if ((operation.op & OPERATION.ADD) == OPERATION.ADD) {
        if (ref instanceof MapSchema) {
            //
            // MapSchema dynamic key
            //
            const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);
            encode.string(bytes, dynamicIndex);
        }
    }

    if (operation.op === OPERATION.DELETE) {
        //
        // TODO: delete from filter cache data.
        //
        // if (useFilters) {
        //     delete changeTree.caches[fieldIndex];
        // }
        return;
    }

    // const type = changeTree.childType || ref._schema[field];
    const type = changeTree.getType(fieldIndex);

    // const type = changeTree.getType(fieldIndex);
    const value = changeTree.getValue(fieldIndex);

    // ensure refId for the value
    if (value && value[$changes]) {
        value[$changes].ensureRefId();
    }

    if (operation.op === OPERATION.TOUCH) {
        return;
    }

    if (Schema.is(type)) {
        assertInstanceType(value, type as typeof Schema, ref as Schema, operation.index);

        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$changes].refId);

        // Try to encode inherited TYPE_ID if it's an ADD operation.
        if ((operation.op & OPERATION.ADD) === OPERATION.ADD) {
            encoder.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema);
        }

    } else if (typeof(type) === "string") {
        //
        // Primitive values
        //
        encodePrimitiveType(type as PrimitiveType, bytes, value, ref as Schema, operation.index);

    } else {
        //
        // Custom type (MapSchema, ArraySchema, etc)
        //
        const definition = getType(Object.keys(type)[0]);

        //
        // ensure a ArraySchema has been provided
        //
        assertInstanceType(ref[operation.index], definition.constructor, ref as Schema, operation.index);

        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$changes].refId);
    }

}