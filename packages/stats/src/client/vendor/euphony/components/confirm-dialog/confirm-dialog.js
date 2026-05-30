import{v as t,i as e,e as i,r as o,a as s,b as a,w as c}from"../../chunks/third-party.js";import{c as n}from"../../chunks/css/confirm-dialog.js";var l=Object.defineProperty,r=Object.getOwnPropertyDescriptor,d=(t,e,i,o)=>{for(var s,a=o>1?void 0:o?r(e,i):e,c=t.length-1;c>=0;c--)(s=t[c])&&(a=(o?s(e,i,a):s(a))||a);return o&&a&&l(e,i,a),a};let h=class extends s{constructor(){super(),this.header="Delete Item",this.message="Are you sure you want to delete this item? This action cannot be undone.",this.yesButtonText="Delete",this.actionKey="deletion",this.initData=async()=>{},this.confirmAction=()=>{},this.cancelAction=()=>{}}firstUpdated(){window.setTimeout(()=>{},1e3)}willUpdate(t){}show(t,e,i){this.header=t.header,this.message=t.message,this.yesButtonText=t.yesButtonText,this.actionKey=t.actionKey,this.confirmAction=e,this.cancelAction=void 0===i?()=>{}:i,"true"===localStorage.getItem(`<skip-confirm>${this.actionKey}`)?this.confirmAction():this.dialogElement&&this.dialogElement.showModal()}dialogClicked(t){t.target===this.dialogElement&&this.dialogElement.close()}cancelClicked(t){t.stopPropagation(),this.dialogElement&&(this.dialogElement.close(),this.cancelAction())}confirmClicked(t){if(t.stopPropagation(),this.dialogElement){if(this.dialogElement.querySelector("#checkbox-skip-confirmation")?.checked){const t=`<skip-confirm>${this.actionKey}`;localStorage.setItem(t,"true")}this.confirmAction(),this.dialogElement.close()}}render(){return a`
      <dialog
        class="confirm-dialog"
        @click=${t=>{this.dialogClicked(t)}}
      >
        <div class="header">
          <div class="header-name">${this.header}</div>
        </div>

        <div class="content">
          <div class="message">${this.message}</div>
          <div class="skip-bar">
            <input
              type="checkbox"
              id="checkbox-skip-confirmation"
              name="checkbox-skip-confirmation"
            />
            <label for="checkbox-skip-confirmation"
              >Don't ask me again about this action</label
            >
          </div>
        </div>

        <div class="button-block">
          <button
            class="cancel-button"
            @click=${t=>{this.cancelClicked(t)}}
          >
            Cancel
          </button>
          <button
            class="confirm-button"
            @click=${t=>{this.confirmClicked(t)}}
          >
            ${this.yesButtonText}
          </button>
        </div>
      </dialog>
    `}};h.styles=[e`
      ${t(n)}
    `],d([i("dialog")],h.prototype,"dialogElement",2),d([o()],h.prototype,"header",2),d([o()],h.prototype,"message",2),d([o()],h.prototype,"yesButtonText",2),h=d([c("nightjar-confirm-dialog")],h);export{h as NightjarConfirmDialog};