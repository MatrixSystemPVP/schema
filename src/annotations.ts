import "./symbol.shim";
import { ChangeTree, Ref, Root } from './changes/ChangeTree';
import { $changes, $childType, Schema } from './Schema';
import { ArraySchema } from './types/ArraySchema';
import { MapSchema, getMapProxy } from './types/MapSchema';
import { Metadata } from "./Metadata";

/**
 * Data types
 */
export type PrimitiveType =
    "string" |
    "number" |
    "boolean" |
    "int8" |
    "uint8" |
    "int16" |
    "uint16" |
    "int32" |
    "uint32" |
    "int64" |
    "uint64" |
    "float32" |
    "float64" |
    typeof Schema;

export type DefinitionType = PrimitiveType
    | PrimitiveType[]
    | { array: PrimitiveType }
    | { map: PrimitiveType }
    | { collection: PrimitiveType }
    | { set: PrimitiveType };

export type Definition = { [field: string]: DefinitionType };
export type FilterCallback<
    T extends Schema = any,
    V = any,
    R extends Schema = any
> = (
    ((this: T, client: ClientWithSessionId, value: V) => boolean) |
    ((this: T, client: ClientWithSessionId, value: V, root: R) => boolean)
);

export type FilterChildrenCallback<
    T extends Schema = any,
    K = any,
    V = any,
    R extends Schema = any
> = (
    ((this: T, client: ClientWithSessionId, key: K, value: V) => boolean) |
    ((this: T, client: ClientWithSessionId, key: K, value: V, root: R) => boolean)
)

export function hasFilter(klass: typeof Schema) {
    // return klass._context && klass._context.useFilters;
    return false;
}

// Colyseus integration
export type ClientWithSessionId = { sessionId: string } & any;

export interface TypeOptions {
    manual?: boolean,
    stream?: boolean, // TODO: not implemented
}

export class TypeContext {
    types: {[id: number]: typeof Schema} = {};
    schemas = new Map<typeof Schema, number>();

    /**
     * For inheritance support
     * Keeps track of which classes extends which. (parent -> children)
     */
    static inheritedTypes = new Map<typeof Schema, Set<typeof Schema>>();

    static register(target: typeof Schema) {
        const parent = Object.getPrototypeOf(target);
        if (parent !== Schema) {
            let inherits = TypeContext.inheritedTypes.get(parent);
            if (!inherits) {
                inherits = new Set<typeof Schema>();
                TypeContext.inheritedTypes.set(parent, inherits);
            }
            inherits.add(target);
        }
    }

    constructor(rootClass?: typeof Schema) {
        // console.log("new TypeContext.........");

        if (rootClass) {
            this.discoverTypes(rootClass);
        }
    }

    has(schema: typeof Schema) {
        return this.schemas.has(schema);
    }

    get(typeid: number) {
        return this.types[typeid];
    }

    add(schema: typeof Schema, typeid: number = this.schemas.size) {
        // skip if already registered
        if (this.schemas.has(schema)) {
            return false;
        }

        // console.log("TypeContext, add =>", Object.keys(schema[Symbol.metadata]));

        this.types[typeid] = schema;
        this.schemas.set(schema, typeid);
        return true;
    }

    getTypeId(klass: typeof Schema) {
        return this.schemas.get(klass);
    }

    private discoverTypes(klass: typeof Schema) {
        if (!this.add(klass)) {
            return;
        }

        // add classes inherited from this base class
        TypeContext.inheritedTypes.get(klass)?.forEach((child) => {
            this.discoverTypes(child);
        });

        // skip if no fields are defined for this class.
        if (klass[Symbol.metadata] === undefined) {
            klass[Symbol.metadata] = {};
        }

        // const metadata = Metadata.getFor(klass);
        const metadata = klass[Symbol.metadata];

        for (const field in metadata) {
            const fieldType = metadata[field].type;

            if (typeof(fieldType) === "string") {
                continue;
            }

            if (Array.isArray(fieldType)) {
                const type = fieldType[0];
                if (type === "string") {
                    continue;
                }
                this.discoverTypes(type as typeof Schema);

            } else if (typeof(fieldType) === "function") {
                this.discoverTypes(fieldType);

            } else {
                const type = Object.values(fieldType)[0];
                if (type === "string") {
                    continue;
                }
                this.discoverTypes(type as typeof Schema);
            }
        }
    }
}

export function entity(constructor, context: ClassDecoratorContext) {
    if (!constructor._definition) {
        // for inheritance support
        TypeContext.register(constructor);
    }

    return constructor;
}

/**
 * [See documentation](https://docs.colyseus.io/state/schema/)
 *
 * Annotate a Schema property to be serializeable.
 * \@type()'d fields are automatically flagged as "dirty" for the next patch.
 *
 * @example Standard usage, with automatic change tracking.
 * ```
 * \@type("string") propertyName: string;
 * ```
 *
 * @example You can provide the "manual" option if you'd like to manually control your patches via .setDirty().
 * ```
 * \@type("string", { manual: true })
 * ```
 */
// export function type(type: DefinitionType, options?: TypeOptions) {
//     return function ({ get, set }, context: ClassAccessorDecoratorContext): ClassAccessorDecoratorResult<Schema, any> {
//         if (context.kind !== "accessor") {
//             throw new Error("@type() is only supported for class accessor properties");
//         }

//         const field = context.name.toString();

//         //
//         // detect index for this field, considering inheritance
//         //
//         const parent = Object.getPrototypeOf(context.metadata);
//         let fieldIndex: number = context.metadata[-1] // current structure already has fields defined
//             ?? (parent && parent[-1]) // parent structure has fields defined
//             ?? -1; // no fields defined
//         fieldIndex++;

//         if (
//             !parent && // the parent already initializes the `$changes` property
//             !Metadata.hasFields(context.metadata)
//         ) {
//             context.addInitializer(function (this: Ref) {
//                 Object.defineProperty(this, $changes, {
//                     value: new ChangeTree(this),
//                     enumerable: false,
//                     writable: true
//                 });
//             });
//         }

//         Metadata.addField(context.metadata, fieldIndex, field, type);

//         const isArray = ArraySchema.is(type);
//         const isMap = !isArray && MapSchema.is(type);

//         // if (options && options.manual) {
//         //     // do not declare getter/setter descriptor
//         //     definition.descriptors[field] = {
//         //         enumerable: true,
//         //         configurable: true,
//         //         writable: true,
//         //     };
//         //     return;
//         // }

//         return {
//             init(value) {
//                 // TODO: may need to convert ArraySchema/MapSchema here

//                 // do not flag change if value is undefined.
//                 if (value !== undefined) {
//                     this[$changes].change(fieldIndex);

//                     // automaticallty transform Array into ArraySchema
//                     if (isArray) {
//                         if (!(value instanceof ArraySchema)) {
//                             value = new ArraySchema(...value);
//                         }
//                         value[$childType] = Object.values(type)[0];
//                     }

//                     // automaticallty transform Map into MapSchema
//                     if (isMap) {
//                         if (!(value instanceof MapSchema)) {
//                             value = new MapSchema(value);
//                         }
//                         value[$childType] = Object.values(type)[0];
//                     }

//                     // try to turn provided structure into a Proxy
//                     if (value['$proxy'] === undefined) {
//                         if (isMap) {
//                             value = getMapProxy(value);
//                         }
//                     }

//                 }

//                 return value;
//             },

//             get() {
//                 return get.call(this);
//             },

//             set(value: any) {
//                 /**
//                  * Create Proxy for array or map items
//                  */

//                 // skip if value is the same as cached.
//                 if (value === get.call(this)) {
//                     return;
//                 }

//                 if (
//                     value !== undefined &&
//                     value !== null
//                 ) {
//                     // automaticallty transform Array into ArraySchema
//                     if (isArray) {
//                         if (!(value instanceof ArraySchema)) {
//                             value = new ArraySchema(...value);
//                         }
//                         value[$childType] = Object.values(type)[0];
//                     }

//                     // automaticallty transform Map into MapSchema
//                     if (isMap) {
//                         if (!(value instanceof MapSchema)) {
//                             value = new MapSchema(value);
//                         }
//                         value[$childType] = Object.values(type)[0];
//                     }

//                     // try to turn provided structure into a Proxy
//                     if (value['$proxy'] === undefined) {
//                         if (isMap) {
//                             value = getMapProxy(value);
//                         }
//                     }

//                     // flag the change for encoding.
//                     this[$changes].change(fieldIndex);

//                     //
//                     // call setParent() recursively for this and its child
//                     // structures.
//                     //
//                     if (value[$changes]) {
//                         value[$changes].setParent(
//                             this,
//                             this[$changes].root,
//                             Metadata.getIndex(context.metadata, field),
//                         );
//                     }

//                 } else if (get.call(this)) {
//                     //
//                     // Setting a field to `null` or `undefined` will delete it.
//                     //
//                     this[$changes].delete(field);
//                 }

//                 set.call(this, value);
//             },
//         };
//     }
// }

export function type (
    type: DefinitionType,
    options?: TypeOptions
): PropertyDecorator {
    return function (target: typeof Schema, field: string) {
        const constructor = target.constructor as typeof Schema;

        if (!type) {
            throw new Error(`${constructor.name}: @type() reference provided for "${field}" is undefined. Make sure you don't have any circular dependencies.`);
        }

        // for inheritance support
        TypeContext.register(constructor);

        const parentClass = Object.getPrototypeOf(constructor);
        const parentMetadata = parentClass[Symbol.metadata];
        const metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

        /**
         * skip if descriptor already exists for this field (`@deprecated()`)
         */
        if (metadata[field]) {
            if (metadata[field].deprecated) {
                // do not create accessors for deprecated properties.
                return;

            } else {
                // trying to define same property multiple times across inheritance.
                // https://github.com/colyseus/colyseus-unity3d/issues/131#issuecomment-814308572
                try {
                    throw new Error(`@colyseus/schema: Duplicate '${field}' definition on '${constructor.name}'.\nCheck @type() annotation`);

                } catch (e) {
                    const definitionAtLine = e.stack.split("\n")[4].trim();
                    throw new Error(`${e.message} ${definitionAtLine}`);
                }
            }
        }

        //
        // detect index for this field, considering inheritance
        //
        let fieldIndex: number = metadata[-1] // current structure already has fields defined
            ?? (parentMetadata && parentMetadata[-1]) // parent structure has fields defined
            ?? -1; // no fields defined
        fieldIndex++;

        Metadata.addField(metadata, fieldIndex, field, type);

        const isArray = ArraySchema.is(type);
        const isMap = !isArray && MapSchema.is(type);

        if (options && options.manual) {
            // do not declare getter/setter descriptor
            metadata[field].descriptor = {
                enumerable: true,
                configurable: true,
                writable: true,
            };
            return;
        }

        const fieldCached = `_${field}`;
        // definition.descriptors[fieldCached] = {
        //     enumerable: false,
        //     writable: true,
        //     configurable: false,
        // };

        metadata[field].descriptor = {
            get: function () {
                return this[fieldCached];
            },

            set: function (this: Schema, value: any) {
                /**
                 * Create Proxy for array or map items
                 */

                // skip if value is the same as cached.
                if (value === this[fieldCached]) {
                    return;
                }

                if (
                    value !== undefined &&
                    value !== null
                ) {
                    // automaticallty transform Array into ArraySchema
                    if (isArray && !(value instanceof ArraySchema)) {
                        value = new ArraySchema(...value);
                    }

                    // automaticallty transform Map into MapSchema
                    if (isMap && !(value instanceof MapSchema)) {
                        value = new MapSchema(value);
                    }

                    // try to turn provided structure into a Proxy
                    if (value['$proxy'] === undefined) {
                        if (isMap) {
                            value = getMapProxy(value);
                        }
                    }

                    // flag the change for encoding.
                    this[$changes].change(fieldIndex);

                    //
                    // call setParent() recursively for this and its child
                    // structures.
                    //
                    if (value['$changes']) {
                        (value['$changes'] as ChangeTree).setParent(
                            this,
                            this[$changes].root,
                            metadata[field].index,
                        );
                    }

                } else if (this[fieldCached]) {
                    //
                    // Setting a field to `null` or `undefined` will delete it.
                    //
                    this[$changes].delete(field);
                }

                this[fieldCached] = value;
            },

            enumerable: true,
            configurable: true
        };
    }
}

/**
 * `@filter()` decorator for defining data filters per client
 */

export function filter<T extends Schema, V, R extends Schema>(cb: FilterCallback<T, V, R>): PropertyDecorator {
    return function (target: any, field: string) {
        const constructor = target.constructor as typeof Schema;
        // const definition = constructor._definition;

        // if (definition.addFilter(field, cb)) {
        //     constructor._context.useFilters = true;
        // }
    }
}

export function filterChildren<T extends Schema, K, V, R extends Schema>(cb: FilterChildrenCallback<T, K, V, R>): PropertyDecorator {
    return function (target: any, field: string) {
        const constructor = target.constructor as typeof Schema;
        // const definition = constructor._definition;
        // if (definition.addChildrenFilter(field, cb)) {
        //     constructor._context.useFilters = true;
        // }
    }
}


/**
 * `@deprecated()` flag a field as deprecated.
 * The previous `@type()` annotation should remain along with this one.
 */

export function deprecated(throws: boolean = true): PropertyDecorator {
    return function (target: typeof Schema, field: string) {
        const constructor = target.constructor as typeof Schema;
        // const definition = constructor._definition;

        // definition.deprecated[field] = true;

        // if (throws) {
        //     definition.descriptors[field] = {
        //         get: function () { throw new Error(`${field} is deprecated.`); },
        //         set: function (this: Schema, value: any) { /* throw new Error(`${field} is deprecated.`); */ },
        //         enumerable: false,
        //         configurable: true
        //     };
        // }
    }
}

// export function defineTypes(
//     target: typeof Schema,
//     fields: { [property: string]: DefinitionType },
//     options?: TypeOptions
// ) {
//     // if (!options.context) {
//     //     options.context = target._context || options.context || globalContext;
//     // }

//     for (let field in fields) {
//         type(fields[field], options)(target.prototype, field);
//     }
//     return target;
// }
