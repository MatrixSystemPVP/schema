import * as assert from "assert";
import { Schema, type, Reflection } from "../src";

describe("Community cases", () => {

    xit("colyseus/schema/issues/143", () => {
        class OptionalSubScheam extends Schema {
            @type('number')  index: number = 200;
            @type('string')  my_string: string = 'a good string';
        }

        class Test extends Schema {
            @type('number') size: number = 0; // total number of storage slots in this container.
            @type('boolean') transient?: boolean;
            @type(OptionalSubScheam) sub?: OptionalSubScheam;
        }

        const testobj = new Test();
        const encoded = testobj.encodeAll();
        const handshake = Reflection.encode(testobj);

        const clientobj = Reflection.decode<Test>(handshake);
        assert.strictEqual(clientobj.sub, undefined);
    });

});
