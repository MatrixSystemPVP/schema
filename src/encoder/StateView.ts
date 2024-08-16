import { ChangeTree, Ref } from "./ChangeTree";
import { $changes } from "../types/symbols";
import { DEFAULT_VIEW_TAG } from "../annotations";
import { OPERATION } from "../encoding/spec";
import { Metadata } from "../Metadata";
import type { Schema } from "../Schema";

export function createView(root: Schema) {
}

export class StateView {
    /**
     * List of ChangeTree's that are visible to this view
     */
    items: WeakSet<ChangeTree> = new WeakSet<ChangeTree>();

    /**
     * List of ChangeTree's that are invisible to this view
     */
    invisible: WeakSet<ChangeTree> = new WeakSet<ChangeTree>();

    tags?: WeakMap<ChangeTree, Set<number>>; // TODO: use bit manipulation instead of Set<number> ()

    /**
     * Manual "ADD" operations for changes per ChangeTree, specific to this view.
     * (This is used to force encoding a property, even if it was not changed)
     */
    changes = new Map<ChangeTree, Map<number, OPERATION>>();

    // TODO: allow to set multiple tags at once
    add(obj: Ref, tag: number = DEFAULT_VIEW_TAG, checkIncludeParent: boolean = true) {
        if (!obj[$changes]) {
            console.warn("StateView#add(), invalid object:", obj);
            return this;
        }

        // FIXME: ArraySchema/MapSchema does not have metadata
        const metadata: Metadata = obj.constructor[Symbol.metadata];
        const changeTree: ChangeTree = obj[$changes];
        this.items.add(changeTree);

        // add parent ChangeTree's
        // - if it was invisible to this view
        // - if it were previously filtered out
        if (checkIncludeParent && changeTree.parent) {
            this.addParent(changeTree.parent[$changes], changeTree.parentIndex, tag);
        }

        //
        // TODO: when adding an item of a MapSchema, the changes may not
        // be set (only the parent's changes are set)
        //
        let changes = this.changes.get(changeTree);
        if (changes === undefined) {
            changes = new Map<number, OPERATION>();
            this.changes.set(changeTree, changes)
        }

        // set tag
        if (tag !== DEFAULT_VIEW_TAG) {
            if (!this.tags) {
                this.tags = new WeakMap<ChangeTree, Set<number>>();
            }
            let tags: Set<number>;
            if (!this.tags.has(changeTree)) {
                tags = new Set<number>();
                this.tags.set(changeTree, tags);
            } else {
                tags = this.tags.get(changeTree);
            }
            tags.add(tag);

            // Ref: add tagged properties
            metadata?.[-3]?.[tag]?.forEach((index) => {
                if (changeTree.getChange(index) !== OPERATION.DELETE) {
                    changes.set(index, OPERATION.ADD)
                }
            });

        } else {
            const isInvisible = this.invisible.has(changeTree);
            const changeSet = (changeTree.isFiltered || changeTree.isPartiallyFiltered)
                ? changeTree.allFilteredChanges
                : changeTree.allChanges;

            changeSet.forEach((op, index) => {
                const tagAtIndex = metadata?.[metadata?.[index]].tag;
                if (
                    (
                        isInvisible || // if "invisible", include all
                        tagAtIndex === undefined || // "all change" with no tag
                        tagAtIndex === tag // tagged property
                    ) &&
                    op !== OPERATION.DELETE
                ) {
                    changes.set(index, op);
                }
            });
        }

        // Add children of this ChangeTree to this view
        changeTree.forEachChild((change, index) => {
            // Do not ADD children that don't have the same tag
            if (metadata && metadata[metadata[index]].tag !== tag) {
                return;
            }
            this.add(change.ref, tag, false);
        });

        return this;
    }

    protected addParent(changeTree: ChangeTree, parentIndex: number, tag: number) {
        // view must have all "changeTree" parent tree
        this.items.add(changeTree);

        // add parent's parent
        const parentChangeTree = changeTree.parent?.[$changes];
        if (parentChangeTree && (parentChangeTree.isFiltered || parentChangeTree.isPartiallyFiltered)) {
            this.addParent(parentChangeTree, changeTree.parentIndex, tag);
        }

        // parent is already available, no need to add it!
        if (!this.invisible.has(changeTree)) {
            return;
        }

        // add parent's tag properties
        if (changeTree.getChange(parentIndex) !== OPERATION.DELETE) {

            let changes = this.changes.get(changeTree);
            if (changes === undefined) {
                changes = new Map<number, OPERATION>();
                this.changes.set(changeTree, changes);
            }

            if (!this.tags) {
                this.tags = new WeakMap<ChangeTree, Set<number>>();
            }

            let tags: Set<number>;
            if (!this.tags.has(changeTree)) {
                tags = new Set<number>();
                this.tags.set(changeTree, tags);
            } else {
                tags = this.tags.get(changeTree);
            }
            tags.add(tag);

            changes.set(parentIndex, OPERATION.ADD);
        }
    }

    remove(obj: Ref, tag: number = DEFAULT_VIEW_TAG) {
        const changeTree = obj[$changes];
        if (!changeTree) {
            console.warn("StateView#remove(), invalid object:", obj);
            return this;
        }

        this.items.delete(changeTree);

        const ref = changeTree.ref;
        const metadata: Metadata = ref.constructor[Symbol.metadata];

        let changes = this.changes.get(changeTree);
        if (changes === undefined) {
            changes = new Map<number, OPERATION>();
            this.changes.set(changeTree, changes)
        }

        if (tag === DEFAULT_VIEW_TAG) {
            // parent is collection (Map/Array)
            const parent = changeTree.parent;
            if (!Metadata.isValidInstance(parent)) {
                const parentChangeTree = parent[$changes];
                let changes = this.changes.get(parentChangeTree);
                if (changes === undefined) {
                    changes = new Map<number, OPERATION>();
                    this.changes.set(parentChangeTree, changes)
                }
                // DELETE / DELETE BY REF ID
                changes.set(changeTree.parentIndex, OPERATION.DELETE);

            } else {
                // delete all "tagged" properties.
                metadata[-2].forEach((index) =>
                    changes.set(index, OPERATION.DELETE));
            }


        } else {
            // delete only tagged properties
            metadata[-3][tag].forEach((index) =>
                changes.set(index, OPERATION.DELETE));
        }

        // remove tag
        if (this.tags && this.tags.has(changeTree)) {
            const tags = this.tags.get(changeTree);
            if (tag === undefined) {
                // delete all tags
                this.tags.delete(changeTree);
            } else {
                // delete specific tag
                tags.delete(tag);

                // if tag set is empty, delete it entirely
                if (tags.size === 0) {
                    this.tags.delete(changeTree);
                }
            }
        }

        return this;
    }
}