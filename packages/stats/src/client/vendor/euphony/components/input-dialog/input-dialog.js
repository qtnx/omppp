import{v as e,i as t,e as i,r as s,a,b as o,w as n}from"../../chunks/third-party.js";import{c as r}from"../../chunks/css/input-dialog.js";var l=Object.defineProperty,d=Object.getOwnPropertyDescriptor,c=(e,t,i,s)=>{for(var a,o=s>1?void 0:s?d(t,i):t,n=e.length-1;n>=0;n--)(a=e[n])&&(o=(s?a(t,i,o):a(o))||o);return s&&o&&l(t,i,o),o};let h=class extends a{constructor(){super(),this.header="Delete Item",this.message="Are you sure you want to delete this item? This action cannot be undone.",this.yesButtonText="Delete",this.errorMessage="Invalid input, please try again.",this.isError=!1,this.isLoading=!1,this.inputStorageKey="deletion",this.initData=async()=>{},this.confirmAction=e=>{},this.cancelAction=()=>{},this.inputValidate=()=>!0}firstUpdated(){window.setTimeout(()=>{},1e3)}willUpdate(e){}show(e,t,i,s){this.header=e.header,this.message=e.message,this.yesButtonText=e.yesButtonText,this.confirmAction=t,this.errorMessage=e.errorMessage||this.errorMessage,this.cancelAction=void 0===i?()=>{}:i,this.inputValidate=void 0===s?()=>!0:s,this.dialogElement&&this.dialogElement.showModal()}dialogClicked(e){e.target===this.dialogElement&&this.dialogElement.close()}cancelClicked(e){e.stopPropagation(),this.dialogElement&&(this.dialogElement.close(),this.cancelAction())}async confirmClicked(e){if(e.stopPropagation(),this.dialogElement){const e=this.dialogElement.querySelector("#input-element");this.isLoading=!0,this.isError=!1;const t=e?.value||"";await this.inputValidate(t)?(this.isLoading=!1,this.confirmAction(t),this.dialogElement.close()):(this.isLoading=!1,this.isError=!0)}}render(){return o`
      <dialog
        class="input-dialog"
        @click=${e=>{this.dialogClicked(e)}}
      >
        <div class="header">
          <div class="header-name">${this.header}</div>
        </div>

        <div class="content">
          <div class="message">${this.message}</div>

          <div class="input-container">
            <sl-input
              id="input-element"
              size="medium"
              placeholder="OpenAI API Key"
              clearable
              spellcheck="false"
            >
            </sl-input>
          </div>
        </div>

        <div class="footer-container">
          <div class="message validating-message" ?is-hidden=${!this.isLoading}>
            Validating...
          </div>
          <div class="message error-message" ?is-hidden=${!this.isError}>
            ${this.errorMessage}
          </div>

          <div class="button-block">
            <button
              class="cancel-button"
              @click=${e=>{this.cancelClicked(e)}}
            >
              Cancel
            </button>
            <button
              class="confirm-button"
              @click=${e=>{this.confirmClicked(e)}}
            >
              ${this.yesButtonText}
            </button>
          </div>
        </div>
      </dialog>
    `}};h.styles=[t`
      ${e(r)}
    `],c([i("dialog")],h.prototype,"dialogElement",2),c([s()],h.prototype,"header",2),c([s()],h.prototype,"message",2),c([s()],h.prototype,"yesButtonText",2),c([s()],h.prototype,"errorMessage",2),c([s()],h.prototype,"isError",2),c([s()],h.prototype,"isLoading",2),h=c([n("nightjar-input-dialog")],h);export{h as NightjarInputDialog};