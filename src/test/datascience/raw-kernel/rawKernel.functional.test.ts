// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { KernelMessage } from '@jupyterlab/services';
import { assert } from 'chai';
import * as fs from 'fs-extra';
import { noop } from 'jquery';
import * as os from 'os';
import * as path from 'path';
import { Observable } from 'rxjs';
import * as uuid from 'uuid/v4';
import { IPythonExecutionFactory, ObservableExecutionResult } from '../../../client/common/process/types';
import { createDeferred } from '../../../client/common/utils/async';
import { IJMPConnection } from '../../../client/datascience/types';
import { DataScienceIocContainer } from '../dataScienceIocContainer';

// tslint:disable:no-any no-multiline-string max-func-body-length no-console max-classes-per-file trailing-comma
suite('DataScience raw kernel tests', () => {
    let ioc: DataScienceIocContainer;
    let enchannelConnection: IJMPConnection;
    let connectionFile: string;
    let kernelProcResult: ObservableExecutionResult<string>;
    let messageObservable: Observable<KernelMessage.IMessage<KernelMessage.MessageType>>;
    let sessionId: string;
    const connectionInfo = {
        shell_port: 57718,
        iopub_port: 57719,
        stdin_port: 57720,
        control_port: 57721,
        hb_port: 57722,
        ip: '127.0.0.1',
        key: 'c29c2121-d277576c2c035f0aceeb5068',
        transport: 'tcp',
        signature_scheme: 'hmac-sha256',
        kernel_name: 'python3',
        version: 5.1
    };
    setup(async function () {
        ioc = new DataScienceIocContainer();
        ioc.registerDataScienceTypes();
        await ioc.activate();
        if (ioc.mockJupyter) {
            // tslint:disable-next-line: no-invalid-this
            this.skip();
        } else {
            await connectToKernel(57718);
        }
    });

    teardown(async () => {
        await disconnectFromKernel();
        await ioc.dispose();
    });

    async function connectToKernel(startPort: number) {
        connectionInfo.stdin_port = startPort;
        connectionInfo.shell_port = startPort + 1;
        connectionInfo.iopub_port = startPort + 2;
        connectionInfo.hb_port = startPort + 3;
        connectionInfo.control_port = startPort + 4;
        enchannelConnection = ioc.get<IJMPConnection>(IJMPConnection);

        // Find our jupyter interpreter
        const interpreter = await ioc.getJupyterCapableInterpreter();
        assert.ok(interpreter, 'No jupyter interpreter found');
        // Start our kernel
        const execFactory = ioc.get<IPythonExecutionFactory>(IPythonExecutionFactory);
        const env = await execFactory.createActivatedEnvironment({ interpreter });

        connectionFile = path.join(os.tmpdir(), `tmp_${Date.now()}_k.json`);
        await fs.writeFile(connectionFile, JSON.stringify(connectionInfo), { encoding: 'utf-8', flag: 'w' });

        // Keep kernel alive while the tests are running.
        kernelProcResult = env.execObservable(['-m', 'ipykernel_launcher', '-f', connectionFile], {
            throwOnStdErr: false
        });
        kernelProcResult.out.subscribe(
            (out) => {
                console.log(out.out);
            },
            (error) => {
                console.error(error);
            },
            () => {
                enchannelConnection.dispose();
            }
        );
        sessionId = uuid();
        await enchannelConnection.connect(connectionInfo);
        messageObservable = new Observable((subscriber) => {
            enchannelConnection.subscribe(subscriber.next.bind(subscriber));
        });
    }

    async function disconnectFromKernel() {
        kernelProcResult?.proc?.kill();
        try {
            await fs.remove(connectionFile);
        } catch {
            noop();
        }
        enchannelConnection.dispose();
    }

    function createShutdownMessage(): KernelMessage.IMessage<'shutdown_request'> {
        return {
            channel: 'control',
            content: {
                restart: false
            },
            header: {
                date: Date.now().toString(),
                msg_id: uuid(),
                msg_type: 'shutdown_request',
                session: sessionId,
                username: 'user',
                version: '5.1'
            },
            parent_header: {},
            metadata: {}
        };
    }

    function createExecutionMessage(code: string): KernelMessage.IExecuteRequestMsg {
        return {
            channel: 'shell',
            content: {
                code,
                silent: false,
                store_history: false
            },
            header: {
                date: Date.now().toString(),
                msg_id: uuid(),
                msg_type: 'execute_request',
                session: sessionId,
                username: 'user',
                version: '5.1'
            },
            parent_header: {},
            metadata: {}
        };
    }

    function createInspectMessage(code: string): KernelMessage.IInspectRequestMsg {
        return {
            channel: 'shell',
            content: {
                code,
                cursor_pos: code.length,
                detail_level: 1
            },
            header: {
                date: Date.now().toString(),
                msg_id: uuid(),
                msg_type: 'inspect_request',
                session: sessionId,
                username: 'user',
                version: '5.1'
            },
            parent_header: {},
            metadata: {}
        };
    }

    function sendMessage(
        message: KernelMessage.IMessage<KernelMessage.MessageType>
    ): Promise<KernelMessage.IMessage<KernelMessage.MessageType>[]> {
        const waiter = createDeferred<KernelMessage.IMessage<KernelMessage.MessageType>[]>();
        const replies: KernelMessage.IMessage<KernelMessage.MessageType>[] = [];
        let expectedReplyType = 'status';
        switch (message.header.msg_type) {
            case 'shutdown_request':
                expectedReplyType = 'shutdown_reply';
                break;

            case 'execute_request':
                expectedReplyType = 'execute_reply';
                break;

            case 'inspect_request':
                expectedReplyType = 'inspect_reply';
                break;
            default:
                break;
        }
        let foundReply = false;
        let foundIdle = false;
        const subscr = messageObservable.subscribe((m) => {
            replies.push(m);
            if (m.header.msg_type === 'status') {
                foundIdle = (m.content as any).execution_state === 'idle';
            } else if (m.header.msg_type === expectedReplyType) {
                foundReply = true;
            }

            if (m.header.msg_type === 'shutdown_reply') {
                // Special case, status may never come after this.
                waiter.resolve(replies);
            }
            if (!waiter.resolved && foundReply && foundIdle) {
                waiter.resolve(replies);
            }
        });
        enchannelConnection.sendMessage(message);
        return waiter.promise.then((m) => {
            subscr.unsubscribe();
            return m;
        });
    }

    test('Basic connection', async () => {
        const replies = await sendMessage(createShutdownMessage());
        assert.ok(
            replies.find((r) => r.header.msg_type === 'shutdown_reply'),
            'Reply not sent for shutdown'
        );
    });

    test('Basic request', async () => {
        const replies = await sendMessage(createExecutionMessage('a=1\na'));
        const executeResult = replies.find((r) => r.header.msg_type === 'execute_result');
        assert.ok(executeResult, 'Result not found');
        assert.equal((executeResult?.content as any).data['text/plain'], '1', 'Results were not computed');
    });

    test('Multiple requests', async () => {
        let replies = await sendMessage(createExecutionMessage('a=1\na'));
        let executeResult = replies.find((r) => r.header.msg_type === 'execute_result');
        assert.ok(executeResult, 'Result not found');
        replies = await sendMessage(createExecutionMessage('a=2\na'));
        executeResult = replies.find((r) => r.header.msg_type === 'execute_result');
        assert.ok(executeResult, 'Result 2 not found');
        assert.equal((executeResult?.content as any).data['text/plain'], '2', 'Results were not computed');
        replies = await sendMessage(createInspectMessage('a'));
        const inspectResult = replies.find((r) => r.header.msg_type === 'inspect_reply');
        assert.ok(inspectResult, 'Inspect result not found');
        assert.ok((inspectResult?.content as any).data['text/plain'], 'Inspect reply was not computed');
    });

    test('Startup and shutdown', async () => {
        let replies = await sendMessage(createExecutionMessage('a=1\na'));
        let executeResult = replies.find((r) => r.header.msg_type === 'execute_result');
        assert.ok(executeResult, 'Result not found');
        await disconnectFromKernel();
        await connectToKernel(57418);
        replies = await sendMessage(createExecutionMessage('a=1\na'));
        executeResult = replies.find((r) => r.header.msg_type === 'execute_result');
        assert.ok(executeResult, 'Result not found');
    });
});
