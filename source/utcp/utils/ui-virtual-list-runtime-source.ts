import { createHash } from 'crypto';

// Creator 3.7 ScrollView offsets are measured from the viewport's top-left.
// Native references: cocos/ui/scroll-view.ts scrollToOffset/getScrollOffset,
// cocos/2d/framework/ui-transform.ts setAnchorPoint/setContentSize.
const TEMPLATE = `import { _decorator, CCInteger, Component, Node, ScrollView, UITransform, Label, Layout, Widget, Vec2 } from 'cc';
const { ccclass, property, disallowMultiple, executionOrder } = _decorator;

@ccclass('__CCP_VIRTUAL_LIST_CLASS__')
@disallowMultiple
@executionOrder(100)
export class __CCP_VIRTUAL_LIST_CLASS__ extends Component {
    @property(Node) viewport: Node | null = null;
    @property(Node) content: Node | null = null;
    @property([Node]) itemReferences: Node[] = [];
    @property({ type: CCInteger }) itemCount = 0;
    @property({ type: CCInteger }) visibleItems = 1;
    @property({ type: CCInteger }) startIndex = 0;

    private scroll: ScrollView | null = null;
    private rows: { node: Node; transform: UITransform; label: Label }[] = [];
    private rowHeight = 0;
    private firstIndex = -1;
    private savedOffset = 0;
    private initialized = false;
    private boundViewport: Node | null = null;
    private restoreOffset = false;

    protected onEnable(): void {
        this.unbind();
        const scroll = this.getComponent(ScrollView);
        const content = this.content;
        const viewport = this.viewport;
        if (!scroll || !content || !viewport || scroll.content !== content || content.parent !== viewport
            || viewport.parent !== this.node || !viewport.getComponent(UITransform) || !content.getComponent(UITransform)
            || !Number.isInteger(this.itemCount) || this.itemCount < 0 || this.itemCount > 100000
            || !Number.isInteger(this.visibleItems) || this.visibleItems < 1 || this.visibleItems > 20
            || !Number.isInteger(this.startIndex) || this.startIndex < 0 || this.startIndex > this.itemCount
            || this.itemReferences.length !== Math.min(this.itemCount, this.visibleItems + 1)
            || new Set(this.itemReferences).size !== this.itemReferences.length
            || content.children.length !== this.itemReferences.length) {
            throw new Error('CCP virtual list: invalid serialized hierarchy or pool configuration.');
        }
        this.rows = this.itemReferences.map(node => {
            const transform = node && node.getComponent(UITransform);
            const label = node && node.getComponent(Label);
            if (!node || node.parent !== content || !transform || !label
                || node.getComponents(Widget).some(widget => widget.enabled)
                || node.getComponents(Layout).some(layout => layout.enabled)) {
                throw new Error('CCP virtual list: pool rows must be direct fixed-size labels without active Widget/Layout.');
            }
            return { node, transform, label };
        });
        this.scroll = scroll;
        this.boundViewport = viewport;
        scroll.horizontal = false;
        scroll.vertical = true;
        // These components belong to the exact generated content only, never ancestors or siblings.
        for (const layout of content.getComponents(Layout)) layout.enabled = false;
        for (const widget of content.getComponents(Widget)) widget.enabled = false;
        this.restoreOffset = true;
        this.resize();
        this.node.on(ScrollView.EventType.SCROLLING, this.refresh, this);
        viewport.on(Node.EventType.SIZE_CHANGED, this.resize, this);
    }

    protected onDisable(): void {
        if (this.scroll) this.savedOffset = this.offset();
        this.unbind();
    }

    protected onDestroy(): void { this.unbind(); }

    private unbind(): void {
        this.node.off(ScrollView.EventType.SCROLLING, this.refresh, this);
        if (this.boundViewport) this.boundViewport.off(Node.EventType.SIZE_CHANGED, this.resize, this);
        this.boundViewport = null;
        this.scroll = null;
        this.rows = [];
    }

    private resize(): void {
        const scroll = this.scroll;
        const viewport = this.viewport && this.viewport.getComponent(UITransform);
        const content = this.content && this.content.getComponent(UITransform);
        if (!scroll || !viewport || !content) return;
        if (!(viewport.width > 0) || !(viewport.height > 0)
            || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
            throw new Error('CCP virtual list: viewport must have finite positive dimensions.');
        }
        const previousIndex = this.initialized && this.rowHeight > 0
            ? (this.restoreOffset ? this.savedOffset : this.offset()) / this.rowHeight : this.startIndex;
        this.restoreOffset = false;
        this.rowHeight = viewport.height / this.visibleItems;
        content.setAnchorPoint(0, 1);
        content.setContentSize(viewport.width, this.itemCount * this.rowHeight);
        this.content!.setScale(1, 1, 1);
        this.content!.setRotationFromEuler(0, 0, 0);
        for (const row of this.rows) {
            row.transform.setAnchorPoint(0, 1);
            row.label.overflow = Label.Overflow.CLAMP;
            row.label.enableWrapText = false;
            row.transform.setContentSize(viewport.width, this.rowHeight);
            row.node.setScale(1, 1, 1);
            row.node.setRotationFromEuler(0, 0, 0);
        }
        const maximum = Math.max(0, this.itemCount * this.rowHeight - viewport.height);
        const requested = this.initialized ? previousIndex * this.rowHeight : this.startIndex * this.rowHeight;
        this.savedOffset = Math.max(0, Math.min(maximum, requested));
        scroll.stopAutoScroll();
        this.content!.setPosition(-viewport.anchorX * viewport.width, (1 - viewport.anchorY) * viewport.height + this.savedOffset, 0);
        scroll.scrollToOffset(new Vec2(0, this.savedOffset), 0);
        this.initialized = true;
        this.firstIndex = -1;
        this.refresh();
    }

    private offset(): number {
        const maximum = Math.max(0, this.itemCount * this.rowHeight - (this.viewport!.getComponent(UITransform)!.height));
        return Math.max(0, Math.min(maximum, this.scroll!.getScrollOffset().y));
    }

    private refresh(): void {
        if (!this.scroll || this.rowHeight <= 0) return;
        const first = Math.min(Math.floor(this.offset() / this.rowHeight), Math.max(0, this.itemCount - this.rows.length));
        if (first === this.firstIndex) return;
        this.firstIndex = first;
        for (let slot = 0; slot < this.rows.length; slot++) {
            const row = this.rows[slot];
            const index = first + slot;
            row.node.setPosition(0, -index * this.rowHeight, 0);
            row.node.name = 'Item-' + index;
            row.label.string = String(index);
        }
    }
}
`;

export const VIRTUAL_LIST_RUNTIME_CLASS = `CcpVirtualList_${createHash('sha256').update(TEMPLATE).digest('hex').slice(0, 16)}`;
export const VIRTUAL_LIST_RUNTIME_SOURCE = TEMPLATE.replace(/__CCP_VIRTUAL_LIST_CLASS__/g, VIRTUAL_LIST_RUNTIME_CLASS);
