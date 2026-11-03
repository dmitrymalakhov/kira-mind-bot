import assert from 'node:assert/strict';
import test from 'node:test';
import {bindAccountAiOperation,currentAccountAiOperation,withAccountAiOperation} from '../ai/accountPolicy';

test('an explicit user continuation reopens its own quota scope after HTTP completion without leaking authority to detached work',async()=>{
    const continueTask=await withAccountAiOperation({id:'synthetic-user-browser-task',background:false},async()=>bindAccountAiOperation(async()=>currentAccountAiOperation()));
    assert.equal(currentAccountAiOperation(),undefined);
    const results=await Promise.all([continueTask(),withAccountAiOperation({id:'synthetic-other-user-operation',background:false},async()=>{
        assert.deepEqual(await continueTask(),{id:'synthetic-user-browser-task',background:false});return currentAccountAiOperation();
    })]);
    assert.deepEqual(results,[{id:'synthetic-user-browser-task',background:false},{id:'synthetic-other-user-operation',background:false}]);
    assert.equal(currentAccountAiOperation(),undefined);
});
