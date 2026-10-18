import { componentScriptHash } from '../../component-script-source';
import type { IInstanceReference } from '../schemas';
import { ToolError } from '../tool-error';
import { installUiRuntimeComponent } from './ui-runtime-component-install';
import type { UiRuntimeComponentInstallResult } from './ui-runtime-component-install';

const FORM_TEMPLATE = `import { _decorator, Component, Node, EditBox, Button, CCBoolean, CCInteger, isValid } from 'cc';
const { ccclass, property, disallowMultiple } = _decorator;

@ccclass('__CCP_FORM_CLASS__')
@disallowMultiple
export class __CCP_FORM_CLASS__ extends Component {
    @property(Node) input: Node | null = null;
    @property(Node) submit: Node | null = null;
    @property(CCBoolean) required = true;
    @property(CCInteger) minLength = 0;
    private boundInput: Node | null = null;
    private boundSubmit: Node | null = null;
    private inputBox: EditBox | null = null;
    private submitButton: Button | null = null;

    protected onEnable(): void {
        this.unbind();
        const input = this.input;
        const submit = this.submit;
        this.submitButton = submit && isValid(submit) ? submit.getComponent(Button) : null;
        if (this.submitButton) this.submitButton.interactable = false;
        if (!input || !submit || !isValid(input) || !isValid(submit)) return;
        this.boundInput = input;
        this.boundSubmit = submit;
        this.inputBox = input.getComponent(EditBox);
        if (!this.inputBox || !this.submitButton) {
            if (this.submitButton) this.submitButton.interactable = false;
            return;
        }
        input.on(EditBox.EventType.TEXT_CHANGED, this.validate, this);
        input.on(EditBox.EventType.EDITING_RETURN, this.onSubmit, this);
        submit.on(Button.EventType.CLICK, this.onSubmit, this);
        this.validate();
    }

    public validate(): boolean {
        const box = this.inputBox;
        const button = this.submitButton;
        const valid = !!box && isValid(box) && !!button && isValid(button)
            && Number.isInteger(this.minLength) && this.minLength >= 0
            && (!this.required || box.string.length > 0)
            && box.string.length >= this.minLength;
        if (button && isValid(button)) button.interactable = valid;
        return valid;
    }

    // Validation/gating only. No application callback or raw input logging.
    public onSubmit(): boolean {
        if (!this.enabledInHierarchy) return false;
        return this.validate();
    }

    protected onDisable(): void {
        this.unbind();
    }

    protected onDestroy(): void {
        this.unbind();
    }

    private unbind(): void {
        if (this.boundInput && isValid(this.boundInput)) {
            this.boundInput.off(EditBox.EventType.TEXT_CHANGED, this.validate, this);
            this.boundInput.off(EditBox.EventType.EDITING_RETURN, this.onSubmit, this);
        }
        if (this.boundSubmit && isValid(this.boundSubmit)) {
            this.boundSubmit.off(Button.EventType.CLICK, this.onSubmit, this);
        }
        if (this.submitButton && isValid(this.submitButton)) this.submitButton.interactable = false;
        this.boundInput = null;
        this.boundSubmit = null;
        this.inputBox = null;
        this.submitButton = null;
    }
}
`;
const FORM_CLASS = `CcpFormValidation_${componentScriptHash(FORM_TEMPLATE).slice(0, 20)}`;
const FORM_SOURCE = FORM_TEMPLATE.split('__CCP_FORM_CLASS__').join(FORM_CLASS);

export interface FormValidationRuntimeInstallArgs {
    form: IInstanceReference;
    input: IInstanceReference;
    submit: IInstanceReference;
    required: boolean;
    minLength: number;
}
export interface FormValidationRuntimeInstallResult extends UiRuntimeComponentInstallResult {
    formReference: IInstanceReference;
    inputReference: IInstanceReference;
    submitReference: IInstanceReference;
    rules: { required: boolean; minLength: number };
}
function field(raw: unknown, key: string): unknown { return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)[key] : undefined; }
function nodeId(raw: unknown): unknown { return unwrapped(field(raw, 'uuid') ?? field(unwrapped(raw), 'uuid')); }
function unwrapped(raw: unknown): unknown { return raw !== null && typeof raw === 'object' && 'value' in raw ? raw.value : raw; }

/** Installs serialized project-owned lifecycle validation; runtimeVerified stays false until separate playback verification. */
export async function installFormValidationRuntime(args: FormValidationRuntimeInstallArgs): Promise<FormValidationRuntimeInstallResult> {
    if (!args?.form?.id || !args.input?.id || !args.submit?.id || new Set([args.form.id, args.input.id, args.submit.id]).size !== 3 || typeof args.required !== 'boolean' || !Number.isInteger(args.minLength) || args.minLength < 0 || args.minLength > 256 || !args.required && args.minLength > 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide distinct owned form/input/submit node references, required and minLength0..256; positive minLength requires required=true.' });
    args = { form: { id: args.form.id, type: 'cc.Node' }, input: { id: args.input.id, type: 'cc.Node' }, submit: { id: args.submit.id, type: 'cc.Node' }, required: args.required, minLength: args.minLength };
    const form: unknown = await Editor.Message.request('scene', 'query-node', args.form.id);
    const input: unknown = await Editor.Message.request('scene', 'query-node', args.input.id);
    const submit: unknown = await Editor.Message.request('scene', 'query-node', args.submit.id);
    const children = field(form, 'children');
    const components = (node: unknown, type: string): boolean => {
        const rows = field(node, '__comps__');
        return Array.isArray(rows) && rows.filter((row: unknown) => field(row, 'type') === type).length === 1;
    };
    if (nodeId(form) !== args.form.id || nodeId(input) !== args.input.id || nodeId(submit) !== args.submit.id || !Array.isArray(children) || ![args.input.id, args.submit.id].every(id => children.some(child => (typeof child === 'string' ? child : nodeId(child)) === id)) || !components(input, 'cc.EditBox') || !components(submit, 'cc.Button')) throw new ToolError({ code: 'UI_FORM_RUNTIME_PREFLIGHT_FAILED', status: 409, message: 'Exact owned form children and their EditBox/Button identities must be confirmed before runtime installation.', details: { form: args.form, input: args.input, submit: args.submit, retrySafe: false } });
    const installed = await installUiRuntimeComponent({ source: FORM_SOURCE, className: FORM_CLASS, nodeReference: args.form, properties: [
        { name: 'input', type: 'cc.Node', value: args.input.id },
        { name: 'submit', type: 'cc.Node', value: args.submit.id },
        { name: 'required', type: 'Boolean', value: args.required },
        { name: 'minLength', type: 'Number', value: args.minLength },
    ] });
    return { ...installed, formReference: args.form, inputReference: args.input, submitReference: args.submit, rules: { required: args.required, minLength: args.minLength } };
}
