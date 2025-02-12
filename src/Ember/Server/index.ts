import { EventEmitter } from 'events'
import { S101Server } from '../Socket/S101Server'
import { S101Client } from '../Socket'
import {
	EmberElement,
	NumberedTreeNodeImpl,
	ElementType,
	EmberFunction,
	InvocationResult,
	EmberNode,
	Parameter,
	MatrixImpl,
	Matrix,
	Connections,
} from '../../model'
import {
	Collection,
	RootElement,
	NumberedTreeNode,
	QualifiedElement,
	RootType,
	TreeElement,
	EmberValue,
} from '../../types/types'
import { DecodeResult } from '../../encodings/ber/decoder/DecodeResult'
import { toQualifiedEmberNode } from '../Lib/util'
import { berEncode } from '../../encodings/ber'
import { Command, CommandType, FieldFlags, GetDirectory, Invoke } from '../../model/Command'
import { Connection, ConnectionOperation, ConnectionImpl } from '../../model/Connection'
import { InvocationResultImpl } from '../../model/InvocationResult'

const ServerEvents = null

export { EmberServer, ServerEvents }

class EmberServer extends EventEmitter {
	address: string | undefined
	port: number
	tree: Collection<NumberedTreeNode<EmberElement>> = {}

	onInvocation?: (
		emberFunction: NumberedTreeNode<EmberFunction>,
		invocation: NumberedTreeNode<Invoke>
	) => Promise<InvocationResult>
	onSetValue?: (parameter: NumberedTreeNode<Parameter>, value: EmberValue) => Promise<boolean>
	onMatrixOperation?: (Matrix: NumberedTreeNode<Matrix>, connection: Connections) => Promise<void>

	private _server: S101Server
	private _clients: Set<S101Client> = new Set()
	private _subscriptions: { [path: string]: Array<S101Client> } = {}

	constructor(port: number, address?: string) {
		super()

		this.address = address
		this.port = port
		this._server = new S101Server(port, address)

		this._server.on('connection', (client: S101Client) => {
			this._clients.add(client)

			client.on('emberTree', (tree: DecodeResult<Collection<RootElement>>) => this._handleIncoming(tree, client))

			client.on('error', (e) => {
				this.emit('clientError', client, e)
			})

			client.on('disconnected', () => {
				this._clearSubscription(client)
				this._clients.delete(client)
			})
		})
	}

	init(tree: Collection<NumberedTreeNode<EmberElement>>) {
		const setParent = (parent: NumberedTreeNode<EmberElement>, child: NumberedTreeNode<EmberElement>) => {
			child.parent = parent
			if (child.children) {
				for (const c of Object.values(child.children)) {
					setParent(child, c)
				}
			}
		}
		for (const rootEl of Object.values(tree)) {
			if (rootEl.children) {
				for (const c of Object.values(rootEl.children)) {
					setParent(rootEl, c)
				}
			}
		}
		this.tree = tree
		return this._server.listen()
	}

	discard() {
		this._clients.forEach((c) => {
			c.removeAllListeners()
		})
		this._clients.clear()
		this._server.server?.close()
	}

	update<T extends EmberElement>(element: NumberedTreeNode<T>, update: Partial<T>) {
		if (element.contents.type === ElementType.Matrix) {
			const matrix: NumberedTreeNode<Matrix> = element as NumberedTreeNode<Matrix>
			const matrixUpdate: Partial<Matrix> = update as Partial<Matrix>

			if (matrixUpdate.connections) {
				for (const connection of Object.values(matrixUpdate.connections)) {
					this.updateMatrixConnection(matrix, connection)
				}
			}
		}
		for (const [key, value] of Object.entries(update)) {
			element.contents[key as keyof T] = value
		}
		const el = toQualifiedEmberNode(element)
		const data = berEncode([el], RootType.Elements)
		let elPath = el.path
		if (el.contents.type !== ElementType.Node && !('targets' in update || 'sources' in update)) {
			elPath = elPath.slice(0, -2) // remove the last element number
		}

		for (const [path, clients] of Object.entries(this._subscriptions)) {
			if (elPath === path) {
				clients.forEach((client) => {
					client.sendBER(data)
				})
			}
		}
	}

	updateMatrixConnection(element: NumberedTreeNode<Matrix>, update: Connection) {
		if (!element.contents.connections) element.contents.connections = {}
		let connection = element.contents.connections[update.target]
		if (!connection) {
			element.contents.connections[update.target] = new ConnectionImpl(update.target, [])
			connection = element.contents.connections[update.target]
		}
		if (!connection.sources) connection.sources = []

		switch (update.operation) {
			case ConnectionOperation.Connect:
				for (const source of update.sources || []) {
					if (!connection.sources.find((v) => v === source)) {
						connection.sources.push(source)
					}
				}
				break
			case ConnectionOperation.Disconnect:
				for (const source of update.sources || []) {
					connection.sources = connection.sources.filter((oldSource) => oldSource !== source)
				}
				break
			case ConnectionOperation.Absolute:
			default:
				connection.sources = update.sources
				break
		}

		const qualified = toQualifiedEmberNode(element) as QualifiedElement<Matrix>
		qualified.contents = new MatrixImpl(qualified.contents.identifier, undefined, undefined, {
			[connection.target]: connection,
		})
		const data = berEncode([qualified], RootType.Elements)

		for (const [path, clients] of Object.entries(this._subscriptions)) {
			if (qualified.path === path) {
				clients.forEach((client) => {
					client.sendBER(data)
				})
			}
		}
	}

	private _handleIncoming(incoming: DecodeResult<Collection<RootElement>>, client: S101Client) {
		for (const rootEl of Object.values(incoming.value)) {
			if (rootEl.contents.type === ElementType.Command) {
				// command on root
				this._handleCommand('', rootEl as NumberedTreeNode<Command>, client).catch((e) => this.emit('error', e))
			} else if ('path' in rootEl) {
				this._handleNode(rootEl.path || '', rootEl, client)
			} else if ('number' in rootEl) {
				this._handleNode(rootEl.number + '' || '', rootEl, client)
			}
		}
	}

	private _handleNode(
		path: string,
		el: QualifiedElement<EmberElement> | NumberedTreeNode<EmberElement>,
		client: S101Client
	) {
		const children = Object.values(el.children || {})

		if (children[0] && children[0].contents.type === ElementType.Command) {
			this._handleCommand(path, children[0] as NumberedTreeNode<Command>, client).catch((e) => this.emit('error', e))
			return
		} else if (el.contents.type === ElementType.Matrix && 'connections' in el.contents) {
			this._handleMatrix(path, el as QualifiedElement<Matrix> | NumberedTreeNode<Matrix>).catch((e) =>
				this.emit('error', e)
			)
		}

		if (!el.children) {
			if (el.contents.type === ElementType.Parameter) {
				this._handleSetValue(path, el as QualifiedElement<Parameter> | NumberedTreeNode<Parameter>, client).catch((e) =>
					this.emit('error', e)
				)
			}
		} else {
			for (const c of children) {
				this._handleNode(path + '.' + c.number, c, client)
			}
		}
	}

	private async _handleMatrix(path: string, el: QualifiedElement<Matrix> | NumberedTreeNode<Matrix>) {
		if (this.onMatrixOperation) {
			const tree = this.getElementByPath(path)
			if (!tree || tree.contents.type !== ElementType.Matrix || !el.contents.connections) return

			return this.onMatrixOperation(tree as NumberedTreeNode<Matrix>, el.contents.connections)
		}
	}

	private async _handleSetValue(
		path: string,
		el: QualifiedElement<Parameter> | NumberedTreeNode<Parameter>,
		client: S101Client
	) {
		const tree = this.getElementByPath(path)
		if (!tree || tree.contents.type !== ElementType.Parameter || el.contents.value === undefined) return

		let success = false
		if (this.onSetValue) {
			success = await this.onSetValue(tree as NumberedTreeNode<Parameter>, el.contents.value)
		}

		if (!success) {
			const qualified = toQualifiedEmberNode(tree)
			const encoded = berEncode([qualified], RootType.Elements)

			client.sendBER(encoded)
		}
	}

	private async _handleCommand(path: string, el: NumberedTreeNode<Command>, client: S101Client) {
		const tree = path ? this.getElementByPath(path) : this.tree
		if (!tree) return

		if (el.contents.number === CommandType.Subscribe) {
			this._subscribe(path, client)
		} else if (el.contents.number === CommandType.Unsubscribe) {
			this._unsubscribe(path, client)
		} else if (el.contents.number === CommandType.GetDirectory) {
			this._subscribe(path, client) // send updates to client
			this._handleGetDirectory(tree, (el.contents as GetDirectory).dirFieldMask || FieldFlags.Default, client)
		} else if (el.contents.number === CommandType.Invoke) {
			let result: InvocationResult
			if (this.onInvocation) {
				result = await this.onInvocation(tree as NumberedTreeNode<EmberFunction>, el as NumberedTreeNode<Invoke>)
			} else {
				result = new InvocationResultImpl((el as NumberedTreeNode<Invoke>).contents.invocation?.id || -1, false)
			}
			const encoded = berEncode(result, RootType.InvocationResult)
			client.sendBER(encoded)
		}
	}

	getElementByPath(path: string, delimiter = '.') {
		const getNext = (elements: Collection<NumberedTreeNode<EmberElement>>, i?: string) =>
			Object.values(elements || {}).find(
				(r) =>
					r.number === Number(i) ||
					(r.contents as EmberNode).identifier === i ||
					(r.contents as EmberNode).description === i
			)
		const getNextChild = (node: TreeElement<EmberElement>, i: string) => node.children && getNext(node.children, i)

		const numberedPath: Array<number> = []
		const pathArr = path.split(delimiter)
		const i = pathArr.shift()
		let tree: NumberedTreeNode<EmberElement> | undefined = getNext(this.tree, i)
		if (tree?.number) numberedPath.push(tree?.number)

		while (pathArr.length) {
			const i = pathArr.shift()
			if (!i) break
			if (!tree) break
			const next = getNextChild(tree, i)
			if (!next) {
				// not found
				return
			}
			tree = next
			if (!tree) return
			if (tree?.number) numberedPath.push(tree?.number)
		}

		return tree
	}

	private _subscribe(path: string, client: S101Client) {
		this._subscriptions[path] = [...(this._subscriptions[path] || []), client]
	}
	private _unsubscribe(path: string, client: S101Client) {
		if (!this._subscriptions[path]) return

		this._subscriptions[path].forEach((c, i) => {
			if (c === client) {
				this._subscriptions[path].splice(i, 1)
			}
		})
	}
	private _clearSubscription(client: S101Client) {
		for (const path of Object.keys(this._subscriptions)) {
			this._unsubscribe(path, client)
		}
	}

	private _handleGetDirectory(
		tree: Collection<NumberedTreeNode<EmberElement>> | NumberedTreeNode<EmberElement>,
		_dirFieldMasks: FieldFlags,
		client: S101Client
	) {
		if (tree === this.tree) {
			// getDir on root
			const response: Collection<NumberedTreeNode<EmberElement>> = { ...this.tree }
			for (const [i, rootEl] of Object.entries(this.tree)) {
				response[i as unknown as number] = new NumberedTreeNodeImpl(rootEl.number, rootEl.contents)
			}
			const data = berEncode(response, RootType.Elements)
			client.sendBER(data)
		} else {
			const qualified = toQualifiedEmberNode(tree as NumberedTreeNode<EmberElement>)
			qualified.children = {} // destroy ref to this.tree
			if ('children' in tree && tree.children) {
				for (const [i, child] of Object.entries(tree.children)) {
					if (child.contents.type === ElementType.Matrix) {
						// matrix should not have connections, targets and sources:
						qualified.children[i as unknown as number] = new NumberedTreeNodeImpl(
							child.number,
							new MatrixImpl(
								child.contents.identifier,
								undefined,
								undefined,
								undefined,
								child.contents.description,
								child.contents.matrixType,
								child.contents.addressingMode,
								child.contents.targetCount,
								child.contents.sourceCount,
								child.contents.maximumTotalConnects,
								child.contents.maximumConnectsPerTarget,
								child.contents.parametersLocation,
								child.contents.gainParameterNumber,
								child.contents.labels,
								child.contents.schemaIdentifiers,
								child.contents.templateReference
							)
						)
					} else {
						qualified.children[i as unknown as number] = new NumberedTreeNodeImpl(child.number, child.contents)
					}
				}
			}
			const data = berEncode([qualified as RootElement], RootType.Elements)
			client.sendBER(data)
		}
	}
}
