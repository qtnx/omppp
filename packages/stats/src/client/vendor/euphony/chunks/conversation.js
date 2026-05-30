import{v as e,i as t,r as s,e as o,z as n,a as i,b as a,x as r,w as l,n as d,f as h,A as c}from"./third-party.js";import{R as p,g as u,t as g,a as m}from"./harmony-types.js";import{u as v,a as C,b,c as w,s as M,d as y,e as f}from"./utils.js";import"../components/preference-window/preference-window.js";import{s as $}from"./shoelace.js";import"../components/floating-toolbar/floating-toolbar.js";import"../components/json-viewer/json-viewer.js";import"../components/message-code/message-code.js";import"../components/message-developer-content/message-developer-content.js";import"../components/message-editor-popover/message-editor-popover.js";import"../components/message-hidden/message-hidden.js";import"../components/message-system-content/message-system-content.js";import"../components/message-text/message-text.js";import"../components/message-unsupported/message-unsupported.js";import{c as k}from"./css/conversation.js";import{c as L}from"./css/token-window.js";const T='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    d="M13 12C13 11.4477 12.5523 11 12 11C11.4477 11 11 11.4477 11 12V16C11 16.5523 11.4477 17 12 17C12.5523 17 13 16.5523 13 16V12Z"\n    fill="currentColor"\n  />\n  <path\n    d="M12 9.5C12.6904 9.5 13.25 8.94036 13.25 8.25C13.25 7.55964 12.6904 7 12 7C11.3096 7 10.75 7.55964 10.75 8.25C10.75 8.94036 11.3096 9.5 12 9.5Z"\n    fill="currentColor"\n  />\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2ZM4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12Z"\n    fill="currentColor"\n  />\n</svg>\n';var x=Object.defineProperty,S=Object.getOwnPropertyDescriptor,E=(e,t,s,o)=>{for(var n,i=o>1?void 0:o?S(t,s):t,a=e.length-1;a>=0;a--)(n=e[a])&&(i=(o?n(t,s,i):n(i))||i);return o&&i&&x(t,s,i),i};const B=6e4;let D=class extends i{constructor(){super(),this.conversationString=null,this.selectedRenderer="o200k_harmony",this.availableRenderers=["o200k_harmony"],this.showMessage=!1,this.message=null,this.messageType="error",this.isOpen=!1,this.isTokenizing=!1,this.selectedTab="conversation",this.tokens=[],this.decodedTokens=[],this.displayString="",this.tabSliderLeft=0,this.tabSliderWidth=0,this.tabOptions=[{key:"conversation",label:"Conversation"},{key:"token",label:"Tokens"},{key:"token_id",label:"Token IDs"},{key:"display_string",label:"String"}],this.rendererTooltipDebouncer=null,this.initData=async()=>{},this.backdropClicked=e=>{e.stopPropagation(),this.close()}}firstUpdated(){window.setTimeout(()=>{},1e3),this.updateTabSliderPosition()}willUpdate(e){}show(e){this.conversationString=e,this.isOpen=!0,this.refreshRendererList(),this.performHarmonyRender()}close(){this.isOpen=!1}tokenizationSucceeded(e){this.tokens=e.tokens,this.decodedTokens=e.decoded_tokens,this.displayString=e.display_string,this.message="",0===e.partial_success_error_messages.length?(this.messageType="success",this.showMessage=!0,this.message=`${this.tokens.length} tokens rendered from ${this.selectedRenderer}`):(this.message=`${this.tokens.length} tokens rendered from ${this.selectedRenderer}.\n`,this.messageType="error",this.showMessage=!0,this.message+=e.partial_success_error_messages.join("\n")),this.showMessage=!0,this.isTokenizing=!1,this.tokens.length>0?this.tabSelected("token"):this.displayString.length>0&&this.tabSelected("display_string")}tokenizationFailed(e){this.messageType="error",this.message=e,this.showMessage=!0,this.isTokenizing=!1}performHarmonyRender(){if(!this.conversationString)return void console.error("Conversation string not found");this.tabSelected("conversation"),this.tokens=[],this.decodedTokens=[],this.displayString="",this.message="",this.showMessage=!1,this.isTokenizing=!0;const{promise:e,resolve:t,reject:s}=Promise.withResolvers(),o=window.setTimeout(()=>{s("Timeout")},B),n=new CustomEvent("harmony-render-requested",{bubbles:!0,composed:!0,detail:{conversation:this.conversationString,renderer:this.selectedRenderer,resolve:e=>{clearTimeout(o),t(e)},reject:e=>{clearTimeout(o),s(e)}}});this.dispatchEvent(n),e.then(e=>{this.tokenizationSucceeded(e)},e=>{console.error("refresh-renderer-list-requested failed, reason: ",e),this.tokenizationFailed(e)})}refreshRendererList(){const{promise:e,resolve:t,reject:s}=Promise.withResolvers(),o=window.setTimeout(()=>{s("Timeout")},B),n=new CustomEvent("refresh-renderer-list-requested",{bubbles:!0,composed:!0,detail:{resolve:e=>{clearTimeout(o),t(e)},reject:e=>{clearTimeout(o),s(e)}}});this.dispatchEvent(n),e.then(e=>{this.availableRenderers=e},e=>{console.error("refresh-renderer-list-requested failed, reason: ",e)})}tabSelected(e){this.selectedTab=e,this.updateTabSliderPosition()}getSelectedTabIndex(){return Math.max(0,this.tabOptions.findIndex(e=>e.key===this.selectedTab))}updateTabSliderPosition(){window.requestAnimationFrame(()=>{if(0===this.tabButtons.length)return;const e=this.getSelectedTabIndex(),t=this.tabButtons[e]??this.tabButtons[0],s=t.offsetLeft,o=t.offsetWidth;(this.tabSliderLeft!==s||this.tabSliderWidth!==o)&&(this.tabSliderLeft=s,this.tabSliderWidth=o)})}updated(e){super.updated(e),e.has("isOpen")&&this.updateTabSliderPosition()}cancelClicked(e){e.stopPropagation(),this.close()}renderButtonClicked(e){e.stopPropagation(),!this.isTokenizing&&this.performHarmonyRender()}onDragStart(e){if(e.preventDefault(),!this.windowElement)throw new Error("Window element not found");if(this.windowElement.style.top.includes("%")){const e=this.windowElement.clientHeight,t=this.windowElement.clientWidth,s=(window.innerHeight-e)/2,o=(window.innerWidth-t)/2;this.windowElement.style.top=`${s}px`,this.windowElement.style.left=`${o}px`,this.windowElement.style.transform=""}const t=e.clientX,s=e.clientY,o=this.windowElement.offsetTop,n=this.windowElement.offsetLeft,i=e=>{const i=e.clientX-t,a=e.clientY-s;this.windowElement.style.top=`${o+a}px`,this.windowElement.style.left=`${n+i}px`},a=()=>{window.removeEventListener("mousemove",i),window.removeEventListener("mouseup",a)};window.addEventListener("mousemove",i),window.addEventListener("mouseup",a)}render(){let e=a``;this.conversationString&&(e=a`
        <euphony-conversation
          conversation-string=${this.conversationString}
          disable-translation-button
          disable-share-button
          disable-markdown-button
          disable-preference-button
          disable-image-preview-window
          disable-token-window
          disable-conversation-id-copy-button
        ></euphony-conversation>
      `);let t=a` <div class="token-container empty-token-container">
      No tokens rendered
    </div>`;this.tokens.length>0&&(t=a`
        <div class="token-container decoded-token-container">
          ${this.decodedTokens.map((e,t)=>a`<span
                class="decoded-token"
                color-index=${t%5}
                title=${t<this.tokens.length?`${e} (${this.tokens[t]})`:e}
                >${e}</span
              >`)}
        </div>
      `);let s=a` <div
      class="token-container empty-token-container"
    >
      No tokens rendered
    </div>`;this.tokens.length>0&&(s=a`
        <div class="token-container token-id-container">
          ${this.tokens.entries().map(([e,t])=>a`<span class="token-id"
                  >${t.toString()}${e==this.tokens.length-1?"":", "}</span
                >`)}
        </div>
      `);let o=a` <div
      class="token-container empty-token-container"
    >
      No display string rendered
    </div>`;return this.displayString&&(o=a`
        <div class="token-container display-string-container">
          ${this.displayString}
        </div>
      `),a`
      <div
        class="back-drop"
        ?open=${this.isOpen}
        @click=${e=>{this.backdropClicked(e)}}
      ></div>
      <div class="token-window" ?open=${this.isOpen}>
        <div
          class="header"
          @mousedown=${e=>{this.onDragStart(e)}}
        >
          <div class="header-name">Harmony Conversation Tokenizer</div>
        </div>

        <div class="content">
          <div class="renderer-selector">
            <div class="renderer-selector-label">
              <span class="name">Tokenizer</span>
              <span
                class="svg-icon"
                @mouseenter=${e=>{this.rendererInfoMouseEnter(e)}}
                @mouseleave=${()=>{this.rendererInfoMouseLeave()}}
              >
                ${r(T)}
              </span>
            </div>
            <div class="renderer-selector-select-container">
              <div class="renderer-selector-select-box">
                <select
                  class="renderer-selector-select"
                  aria-label="Select tokenizer"
                  .value=${this.selectedRenderer}
                  @change=${e=>{this.selectedRenderer=e.target.value}}
                >
                  ${this.availableRenderers.map(e=>a`<option value="${e}">${e}</option>`)}
                </select>
                <div class="renderer-selector-select-label">
                  ${this.selectedRenderer}
                </div>
              </div>
            </div>
          </div>

          <div class="token-result">
            <div
              class="tab-container"
              role="tablist"
              aria-label="Token view selector"
              style=${`--slider-left: ${this.tabSliderLeft}px; --slider-width: ${this.tabSliderWidth}px;`}
            >
              <div class="tab-slider"></div>
              ${this.tabOptions.map(e=>a`<button
                    class="tab-button"
                    type="button"
                    role="tab"
                    aria-selected=${this.selectedTab===e.key}
                    data-selected=${this.selectedTab===e.key}
                    @click=${()=>{this.tabSelected(e.key)}}
                  >
                    ${e.label}
                  </button>`)}
            </div>

            <div class="result-container">
              <div
                class="tab-panel"
                ?hidden=${"conversation"!==this.selectedTab}
              >
                ${e}
              </div>
              <div class="tab-panel" ?hidden=${"token"!==this.selectedTab}>
                ${t}
              </div>
              <div class="tab-panel" ?hidden=${"token_id"!==this.selectedTab}>
                ${s}
              </div>
              <div
                class="tab-panel"
                ?hidden=${"display_string"!==this.selectedTab}
              >
                ${o}
              </div>
            </div>
          </div>
        </div>

        <div class="footer">
          <div class="left-block">
            <!-- Important to avoid new line and whitespace here -->
            <!-- prettier-ignore -->
            <div class="message" message-type=${this.messageType} ?no-show=${!this.showMessage}>${this.message}</div>

            <div class="loader-container" ?is-loading=${this.isTokenizing}>
              <div class="loader-label">Rendering</div>
              <div class="loader"></div>
            </div>
          </div>

          <div class="button-block">
            <button
              class="cancel-button"
              @click=${e=>{this.cancelClicked(e)}}
            >
              Cancel
            </button>
            <button
              class="render-button"
              ?is-rendering=${this.isTokenizing}
              @click=${e=>{this.renderButtonClicked(e)}}
            >
              Render
            </button>
          </div>
        </div>

        <div
          id="popper-tooltip"
          class="popper-tooltip hidden"
          role="tooltip"
          @click=${e=>{e.stopPropagation()}}
        >
          <div class="popper-content">
            <span class="popper-label"
              >Choose a Harmony tokenizer to see how this conversation is
              serialized and tokenized.</span
            >
          </div>
          <div class="popper-arrow"></div>
        </div>
      </div>
    `}rendererInfoMouseEnter(e){if(e.stopPropagation(),!this.popperTooltip)return void console.error("Popper tooltip not initialized.");const t=e.currentTarget;this.rendererTooltipDebouncer&&clearTimeout(this.rendererTooltipDebouncer),this.rendererTooltipDebouncer=window.setTimeout(()=>{this.popperTooltip.querySelector(".popper-label")?(v(this.popperTooltip,t,"top",!0,7),this.popperTooltip.classList.remove("hidden")):console.error("Tooltip label element missing.")},300)}rendererInfoMouseLeave(e=!0){this.popperTooltip?(this.rendererTooltipDebouncer&&(clearTimeout(this.rendererTooltipDebouncer),this.rendererTooltipDebouncer=null),e?this.popperTooltip.classList.add("hidden"):(this.popperTooltip.classList.add("no-transition"),this.popperTooltip.classList.add("hidden"),setTimeout(()=>{this.popperTooltip.classList.remove("no-transition")},150))):console.error("Popper tooltip not initialized.")}};D.styles=[t`
      ${e(L)}
    `],E([s()],D.prototype,"conversationString",2),E([s()],D.prototype,"selectedRenderer",2),E([s()],D.prototype,"availableRenderers",2),E([o("div.token-window")],D.prototype,"windowElement",2),E([n(".tab-button")],D.prototype,"tabButtons",2),E([s()],D.prototype,"showMessage",2),E([s()],D.prototype,"message",2),E([s()],D.prototype,"messageType",2),E([s()],D.prototype,"isOpen",2),E([s()],D.prototype,"isTokenizing",2),E([s()],D.prototype,"selectedTab",2),E([s()],D.prototype,"tokens",2),E([s()],D.prototype,"decodedTokens",2),E([s()],D.prototype,"displayString",2),E([s()],D.prototype,"tabSliderLeft",2),E([s()],D.prototype,"tabSliderWidth",2),E([o("#popper-tooltip")],D.prototype,"popperTooltip",2),D=E([l("euphony-token-window")],D);const I='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M18.7071 12.7071C19.0976 12.3166 19.0976 11.6834 18.7071 11.2929L13.7071 6.29289C13.3166 5.90237 12.6834 5.90237 12.2929 6.29289C11.9024 6.68342 11.9024 7.31658 12.2929 7.70711L15.5858 11H6C5.44771 11 5 11.4477 5 12C5 12.5523 5.44771 13 6 13H15.5858L12.2929 16.2929C11.9024 16.6834 11.9024 17.3166 12.2929 17.7071C12.6834 18.0976 13.3166 18.0976 13.7071 17.7071L18.7071 12.7071Z"\n    fill="currentColor"\n  />\n</svg>\n',R='<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 24 24"><path d="M11 7.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM14.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path><path fill-rule="evenodd" d="M12 1a1 1 0 0 1 1 1v.5h4a3 3 0 0 1 3 3V9a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V5.5a3 3 0 0 1 3-3h4V2a1 1 0 0 1 1-1ZM7 4.5h10a1 1 0 0 1 1 1V9a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V5.5a1 1 0 0 1 1-1Z" clip-rule="evenodd"></path><path d="M6 21c0-.974.551-1.95 1.632-2.722C8.71 17.508 10.252 17 12 17c1.749 0 3.29.508 4.369 1.278C17.449 19.05 18 20.026 18 21a1 1 0 1 0 2 0c0-1.788-1.016-3.311-2.469-4.35-1.455-1.038-3.414-1.65-5.53-1.65-2.118 0-4.077.611-5.532 1.65C5.016 17.69 4 19.214 4 21a1 1 0 1 0 2 0Z"></path></svg>',P='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M12 7C12.2652 7 12.5196 7.10536 12.7071 7.29289L19.7071 14.2929C20.0976 14.6834 20.0976 15.3166 19.7071 15.7071C19.3166 16.0976 18.6834 16.0976 18.2929 15.7071L12 9.41421L5.70711 15.7071C5.31658 16.0976 4.68342 16.0976 4.29289 15.7071C3.90237 15.3166 3.90237 14.6834 4.29289 14.2929L11.2929 7.29289C11.4804 7.10536 11.7348 7 12 7Z"\n    fill="currentColor"\n  />\n</svg>\n',A='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M12 3.5C10.8954 3.5 10 4.39543 10 5.5H14C14 4.39543 13.1046 3.5 12 3.5ZM8.53513 3.5C9.22675 2.3044 10.5194 1.5 12 1.5C13.4806 1.5 14.7733 2.3044 15.4649 3.5H17.25C18.9069 3.5 20.25 4.84315 20.25 6.5V18.5C20.25 20.1569 19.1569 21.5 17.25 21.5H6.75C5.09315 21.5 3.75 20.1569 3.75 18.5V6.5C3.75 4.84315 5.09315 3.5 6.75 3.5H8.53513ZM8 5.5H6.75C6.19772 5.5 5.75 5.94772 5.75 6.5V18.5C5.75 19.0523 6.19772 19.5 6.75 19.5H17.25C18.0523 19.5 18.25 19.0523 18.25 18.5V6.5C18.25 5.94772 17.8023 5.5 17.25 5.5H16C16 6.60457 15.1046 7.5 14 7.5H10C8.89543 7.5 8 6.60457 8 5.5Z"\n    fill="currentColor"\n  />\n</svg>\n',F='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    d="M7.70711 10.2929C7.31658 9.90237 6.68342 9.90237 6.29289 10.2929C5.90237 10.6834 5.90237 11.3166 6.29289 11.7071L11.2929 16.7071C11.6834 17.0976 12.3166 17.0976 12.7071 16.7071L17.7071 11.7071C18.0976 11.3166 18.0976 10.6834 17.7071 10.2929C17.3166 9.90237 16.6834 9.90237 16.2929 10.2929L13 13.5858L13 4C13 3.44771 12.5523 3 12 3C11.4477 3 11 3.44771 11 4L11 13.5858L7.70711 10.2929Z"\n    fill="currentColor"\n  />\n  <path\n    d="M5 19C4.44772 19 4 19.4477 4 20C4 20.5523 4.44772 21 5 21H19C19.5523 21 20 20.5523 20 20C20 19.4477 19.5523 19 19 19L5 19Z"\n    fill="currentColor"\n  />\n</svg>\n',H='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M2.29291 2.29289C2.68343 1.90237 3.3166 1.90237 3.70712 2.29289L21.7071 20.2929C22.0976 20.6834 22.0976 21.3166 21.7071 21.7071C21.3166 22.0976 20.6834 22.0976 20.2929 21.7071L17.7785 19.1927C16.2039 20.2404 14.274 21 12 21C8.84584 21 6.36062 19.541 4.5586 17.8792C2.76162 16.222 1.58481 14.312 1.01235 13.2562C0.585075 12.4681 0.585779 11.5305 1.01269 10.7432C1.5904 9.67778 2.79205 7.72646 4.63588 6.05008L2.29291 3.70711C1.90238 3.31658 1.90238 2.68342 2.29291 2.29289ZM6.05192 7.46612C4.40725 8.93862 3.30718 10.7074 2.77085 11.6965C2.66598 11.8899 2.66608 12.1102 2.77055 12.3029C3.28868 13.2585 4.34193 14.9588 5.91447 16.4089C7.48198 17.8545 9.50575 19 12 19C13.6494 19 15.09 18.5001 16.3303 17.7445L14.396 15.8102C12.6575 16.9057 10.3324 16.6963 8.81803 15.182C7.3037 13.6676 7.09428 11.3425 8.18977 9.60397L6.05192 7.46612ZM9.67223 11.0864L12.9136 14.3278C12.0164 14.6793 10.9571 14.4927 10.2322 13.7678C9.50734 13.0429 9.32067 11.9836 9.67223 11.0864Z"\n    fill="currentColor"\n  />\n  <path\n    d="M10.2234 5.19987C10.7835 5.07151 11.3753 5 12 5C14.4943 5 16.5181 6.1455 18.0856 7.59105C19.6581 9.04124 20.7114 10.7415 21.2295 11.6971C21.3335 11.8889 21.3338 12.1105 21.2285 12.3047C20.9449 12.8276 20.496 13.5829 19.8836 14.4005C19.5526 14.8426 19.6425 15.4693 20.0846 15.8004C20.5266 16.1315 21.1534 16.0415 21.4844 15.5995C22.1677 14.6872 22.6678 13.8459 22.9866 13.2582C23.4131 12.4717 23.4154 11.5327 22.9877 10.7438C22.4152 9.68799 21.2384 7.77798 19.4414 6.1208C17.6394 4.45899 15.1542 3 12 3C11.2211 3 10.4795 3.08934 9.77664 3.25041C9.23831 3.37379 8.90192 3.9102 9.02529 4.44853C9.14866 4.98686 9.68508 5.32325 10.2234 5.19987Z"\n    fill="currentColor"\n  />\n</svg>\n',U='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M5.91444 7.59106C4.3419 9.04124 3.28865 10.7415 2.77052 11.6971C2.66585 11.8902 2.66585 12.1098 2.77052 12.3029C3.28865 13.2585 4.3419 14.9588 5.91444 16.4089C7.48195 17.8545 9.50572 19 12 19C14.4943 19 16.518 17.8545 18.0855 16.4089C19.6581 14.9588 20.7113 13.2585 21.2295 12.3029C21.3341 12.1098 21.3341 11.8902 21.2295 11.6971C20.7113 10.7415 19.6581 9.04124 18.0855 7.59105C16.518 6.1455 14.4943 5 12 5C9.50572 5 7.48195 6.1455 5.91444 7.59106ZM4.55857 6.1208C6.36059 4.45899 8.84581 3 12 3C15.1542 3 17.6394 4.45899 19.4414 6.1208C21.2384 7.77798 22.4152 9.68799 22.9877 10.7438C23.4147 11.5315 23.4147 12.4685 22.9877 13.2562C22.4152 14.312 21.2384 16.222 19.4414 17.8792C17.6394 19.541 15.1542 21 12 21C8.84581 21 6.36059 19.541 4.55857 17.8792C2.76159 16.222 1.58478 14.312 1.01232 13.2562C0.58525 12.4685 0.585249 11.5315 1.01232 10.7438C1.58478 9.688 2.76159 7.77798 4.55857 6.1208ZM12 9.5C10.6193 9.5 9.49999 10.6193 9.49999 12C9.49999 13.3807 10.6193 14.5 12 14.5C13.3807 14.5 14.5 13.3807 14.5 12C14.5 10.6193 13.3807 9.5 12 9.5ZM7.49999 12C7.49999 9.51472 9.51471 7.5 12 7.5C14.4853 7.5 16.5 9.51472 16.5 12C16.5 14.4853 14.4853 16.5 12 16.5C9.51471 16.5 7.49999 14.4853 7.49999 12Z"\n    fill="currentColor"\n  />\n</svg>\n',Z='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M18.2929 5.70711C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.70711C10.3166 7.09763 9.68341 7.09763 9.29289 6.70711C8.90236 6.31658 8.90236 5.68342 9.29289 5.29289L10.2929 4.29289C12.8926 1.69323 17.1074 1.69323 19.7071 4.29289C22.3068 6.89256 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.70711ZM15.7071 8.29289C16.0976 8.68342 16.0976 9.31658 15.7071 9.70711L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90237 15.3166 7.90237 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68342 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90237 6.31658 8.90237 6.7071 9.29289Z"\n    fill="currentColor"\n  />\n</svg>\n',O='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    d="M6.16146 3.5H17.8385C18.3657 3.49998 18.8205 3.49997 19.195 3.53057C19.5904 3.56287 19.9836 3.63419 20.362 3.82698C20.9265 4.1146 21.3854 4.57354 21.673 5.13803C21.8658 5.51641 21.9371 5.90963 21.9694 6.30497C22 6.67954 22 7.1343 22 7.66144V15.5C22.5523 15.5 22.9999 15.9477 22.9999 16.5V17.5C22.9999 19.1569 21.6568 20.5 19.9999 20.5H3.99622C2.33936 20.5 0.996216 19.1569 0.996216 17.5V16.5C0.996216 15.9477 1.44393 15.5 1.99622 15.5H2L2 7.66146C1.99998 7.13431 1.99997 6.67955 2.03057 6.30497C2.06287 5.90963 2.13419 5.51641 2.32698 5.13803C2.6146 4.57354 3.07354 4.1146 3.63803 3.82698C4.01641 3.63419 4.40963 3.56287 4.80497 3.53057C5.17954 3.49997 5.63431 3.49998 6.16146 3.5ZM3.0014 17.5L3 17.5L2.9986 17.5H2.99622C2.99622 18.0523 3.44393 18.5 3.99622 18.5H19.9999C20.5522 18.5 20.9999 18.0523 20.9999 17.5H20.9986H15.236L14.4472 17.8944C14.3083 17.9639 14.1552 18 13.9999 18H9.99995C9.8447 18 9.69159 17.9639 9.55273 17.8944L8.76388 17.5H3.0014ZM20 15.5V7.7C20 7.12345 19.9992 6.75118 19.9761 6.46784C19.9539 6.19617 19.9162 6.09546 19.891 6.04601C19.7951 5.85785 19.6422 5.70487 19.454 5.609C19.4045 5.5838 19.3038 5.54612 19.0322 5.52393C18.7488 5.50078 18.3766 5.5 17.8 5.5H6.2C5.62345 5.5 5.25117 5.50078 4.96784 5.52393C4.69617 5.54612 4.59545 5.5838 4.54601 5.609C4.35785 5.70487 4.20487 5.85785 4.10899 6.04601C4.0838 6.09546 4.04612 6.19617 4.02393 6.46784C4.00078 6.75117 4 7.12345 4 7.7V15.5H8.99995C9.15519 15.5 9.3083 15.5361 9.44716 15.6056L10.236 16H13.7639L14.5527 15.6056C14.6916 15.5361 14.8447 15.5 14.9999 15.5H20Z"\n    fill="currentColor"\n  />\n</svg>\n',_='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M2 7C2 5.34315 3.34315 4 5 4H6C6.55228 4 7 4.44772 7 5C7 5.55228 6.55228 6 6 6H5C4.44772 6 4 6.44772 4 7V17C4 17.5523 4.44772 18 5 18H6C6.55228 18 7 18.4477 7 19C7 19.5523 6.55228 20 6 20H5C3.34315 20 2 18.6569 2 17V7ZM17 5C17 4.44772 17.4477 4 18 4H19C20.6569 4 22 5.34315 22 7V17C22 18.6569 20.6569 20 19 20H18C17.4477 20 17 19.5523 17 19C17 18.4477 17.4477 18 18 18H19C19.5523 18 20 17.5523 20 17V7C20 6.44772 19.5523 6 19 6H18C17.4477 6 17 5.55228 17 5ZM12 9C12.5523 9 13 9.44772 13 10V14C13 14.5523 12.5523 15 12 15C11.4477 15 11 14.5523 11 14V10C11 9.44772 11.4477 9 12 9ZM15.5 10.5C16.0523 10.5 16.5 10.9477 16.5 11.5V14C16.5 14.5523 16.0523 15 15.5 15C14.9477 15 14.5 14.5523 14.5 14V11.5C14.5 10.9477 14.9477 10.5 15.5 10.5ZM8.5 11.5C9.05228 11.5 9.5 11.9477 9.5 12.5V14C9.5 14.5523 9.05228 15 8.5 15C7.94772 15 7.5 14.5523 7.5 14V12.5C7.5 11.9477 7.94772 11.5 8.5 11.5Z"\n    fill="currentColor"\n  />\n</svg>\n',W='<svg\n  width="20"\n  height="20"\n  viewBox="0 0 20 20"\n  fill="currentColor"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    d="M13.8858 2.71322C14.8344 1.92447 16.2474 1.9732 17.1388 2.86459L17.3057 3.04916C18.0316 3.94013 18.0265 5.22711 17.294 6.11263L17.1261 6.29623L14.711 8.67513L14.8653 8.82943L15.0431 9.02865C15.8122 9.9856 15.6958 11.3368 14.9454 12.2337L14.7755 12.4183C13.6883 13.4902 12.8391 14.6622 12.1798 16.0052L11.9083 16.5912C11.3764 17.8145 9.89971 18.5876 8.58797 17.9271L8.462 17.8587C7.40522 17.2458 6.64667 16.801 5.98153 16.2884C5.38845 15.8314 4.88059 15.3299 4.28719 14.6253L4.02743 14.3109C3.8525 14.0953 3.82988 13.7933 3.97078 13.554L4.35262 12.9046L3.73348 13.1204C3.48317 13.2076 3.20874 13.1373 3.03133 12.9495L2.962 12.8626C2.82204 12.6535 2.68349 12.4395 2.54696 12.2201L2.14168 11.5453C1.3618 10.2032 2.14737 8.64808 3.41024 8.09994L3.99715 7.82943C5.34174 7.17073 6.51501 6.32179 7.58797 5.23568L7.77254 5.06576C8.73426 4.26289 10.2181 4.1871 11.1788 5.14681L11.3321 5.30013L13.7032 2.88217L13.8858 2.71322ZM6.89754 7.60385C6.08373 8.21683 5.21277 8.73808 4.26571 9.17513L3.94051 9.32064C3.24144 9.62398 2.99802 10.3713 3.29207 10.8773L3.67684 11.5169C3.71362 11.576 3.7522 11.6336 3.78914 11.6917L5.62703 11.0521L5.72664 11.0257C5.96159 10.9829 6.20564 11.0704 6.36043 11.2591C6.53695 11.4747 6.56039 11.7777 6.41903 12.0179L5.35457 13.8226C5.88269 14.4443 6.30963 14.8614 6.79403 15.2347C7.37737 15.6842 8.05552 16.0858 9.12899 16.7083L9.22664 16.7572C9.72868 16.9707 10.4043 16.7146 10.6886 16.0609L10.835 15.7357C11.2724 14.7898 11.792 13.9186 12.4054 13.1058L6.89754 7.60385ZM16.1983 3.80502C15.7975 3.40419 15.1621 3.38226 14.7354 3.73666L14.6524 3.81283L11.8116 6.71029C11.6875 6.83692 11.5182 6.90945 11.3409 6.91049C11.1634 6.91141 10.9928 6.84059 10.8673 6.71517L10.2384 6.08724C9.8327 5.68229 9.12999 5.66436 8.63094 6.08138L8.53426 6.17123C8.33552 6.37241 8.13162 6.56445 7.92586 6.75131L13.2579 12.0785C13.4452 11.8726 13.6402 11.6709 13.8419 11.472L13.9307 11.3744C14.3203 10.9092 14.331 10.2674 14.0011 9.85482L13.9249 9.77084L13.296 9.14291C13.1706 9.01761 13.101 8.84656 13.1016 8.66928C13.1024 8.49215 13.1737 8.32289 13.2999 8.19857L16.1925 5.34896L16.2677 5.26595C16.5972 4.86764 16.6 4.28883 16.2735 3.88803L16.1983 3.80502Z"\n  />\n</svg>\n',j='<svg\n  width="20"\n  height="20"\n  viewBox="0 0 20 20"\n  fill="currentColor"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    d="M11.3312 3.56837C12.7488 2.28756 14.9376 2.33009 16.3038 3.6963L16.4318 3.83106C17.6712 5.20294 17.6712 7.29708 16.4318 8.66895L16.3038 8.80372L10.0118 15.0947C9.68833 15.4182 9.45378 15.6553 9.22179 15.8457L8.98742 16.0225C8.78227 16.1626 8.56423 16.2832 8.33703 16.3828L8.10753 16.4756C7.92576 16.5422 7.73836 16.5902 7.5216 16.6348L6.75695 16.7705L4.36339 17.169C4.22053 17.1928 4.06908 17.2188 3.94054 17.2285C3.84177 17.236 3.70827 17.2386 3.56261 17.2031L3.41417 17.1543C3.19115 17.0586 3.00741 16.8908 2.89171 16.6797L2.84581 16.5859C2.75951 16.3846 2.76168 16.1912 2.7716 16.0596C2.7813 15.931 2.80736 15.7796 2.83117 15.6367L3.2296 13.2432L3.36437 12.4785C3.40893 12.2616 3.45789 12.0745 3.52453 11.8926L3.6173 11.6621C3.71685 11.4352 3.83766 11.2176 3.97765 11.0127L4.15343 10.7783C4.34386 10.5462 4.58164 10.312 4.90538 9.98829L11.1964 3.6963L11.3312 3.56837ZM5.84581 10.9287C5.49664 11.2779 5.31252 11.4634 5.18663 11.6162L5.07531 11.7627C4.98188 11.8995 4.90151 12.0448 4.83507 12.1963L4.77355 12.3506C4.73321 12.4607 4.70242 12.5761 4.66808 12.7451L4.54113 13.4619L4.14269 15.8555L4.14171 15.8574H4.14464L6.5382 15.458L7.25499 15.332C7.424 15.2977 7.5394 15.2669 7.64953 15.2266L7.80285 15.165C7.95455 15.0986 8.09947 15.0174 8.23644 14.9238L8.3839 14.8135C8.53668 14.6876 8.72225 14.5035 9.0714 14.1543L14.0587 9.16602L10.8331 5.94044L5.84581 10.9287ZM15.3634 4.63673C14.5281 3.80141 13.2057 3.74938 12.3097 4.48048L12.1368 4.63673L11.7735 5.00001L15.0001 8.22559L15.3634 7.86329L15.5196 7.68946C16.2015 6.85326 16.2015 5.64676 15.5196 4.81056L15.3634 4.63673Z"\n  />\n</svg>\n',q='<svg\n  width="20"\n  height="20"\n  viewBox="0 0 20 20"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    d="M8.21498 2.08301H11.7863C12.6895 2.083 13.4179 2.08299 14.0078 2.13119C14.6152 2.18081 15.1487 2.28566 15.6423 2.53715C16.4263 2.93662 17.0637 3.57404 17.4632 4.35805C17.7147 4.85162 17.8195 5.38511 17.8691 5.99249C17.9173 6.58238 17.9173 7.31084 17.9173 8.21398V11.7854C17.9173 12.6885 17.9173 13.417 17.8691 14.0069C17.8195 14.6142 17.7147 15.1477 17.4632 15.6413C17.0637 16.4253 16.4263 17.0627 15.6423 17.4622C15.1487 17.7137 14.6152 17.8185 14.0078 17.8682C13.4179 17.9164 12.6895 17.9163 11.7863 17.9163H8.21496C7.31181 17.9163 6.58336 17.9164 5.99346 17.8682C5.38609 17.8185 4.8526 17.7137 4.35902 17.4622C3.57502 17.0627 2.9376 16.4253 2.53812 15.6413C2.28663 15.1477 2.18179 14.6142 2.13217 14.0069C2.08397 13.417 2.08398 12.6885 2.08398 11.7853V8.214C2.08398 7.31085 2.08397 6.58239 2.13217 5.99249C2.18179 5.38511 2.28663 4.85162 2.53812 4.35805C2.9376 3.57404 3.57502 2.93662 4.35902 2.53715C4.8526 2.28566 5.38609 2.18081 5.99346 2.13119C6.58336 2.08299 7.31182 2.083 8.21498 2.08301ZM6.12918 3.79232C5.62488 3.83352 5.33514 3.91034 5.11568 4.02216C4.64527 4.26184 4.26282 4.64429 4.02314 5.1147C3.91131 5.33416 3.8345 5.6239 3.7933 6.12821C3.7513 6.64224 3.75065 7.3025 3.75065 8.24967V11.7497C3.75065 12.6968 3.7513 13.3571 3.7933 13.8711C3.8345 14.3754 3.91131 14.6652 4.02314 14.8847C4.26282 15.3551 4.64527 15.7375 5.11568 15.9772C5.33514 16.089 5.62488 16.1658 6.12918 16.207C6.64322 16.249 7.30348 16.2497 8.25065 16.2497H11.7507C12.6978 16.2497 13.3581 16.249 13.8721 16.207C14.3764 16.1658 14.6662 16.089 14.8856 15.9772C15.356 15.7375 15.7385 15.3551 15.9782 14.8847C16.09 14.6652 16.1668 14.3754 16.208 13.8711C16.25 13.3571 16.2507 12.6968 16.2507 11.7497V8.24967C16.2507 7.3025 16.25 6.64224 16.208 6.12821C16.1668 5.6239 16.09 5.33416 15.9782 5.1147C15.7385 4.64429 15.356 4.26184 14.8856 4.02216C14.6662 3.91034 14.3764 3.83352 13.8721 3.79232C13.3581 3.75032 12.6978 3.74967 11.7507 3.74967H8.25065C7.30348 3.74967 6.64322 3.75032 6.12918 3.79232ZM10.0007 5.83301C10.4609 5.83301 10.834 6.2061 10.834 6.66634V9.16634H13.334C13.7942 9.16634 14.1673 9.53944 14.1673 9.99968C14.1673 10.4599 13.7942 10.833 13.334 10.833H10.834V13.333C10.834 13.7932 10.4609 14.1663 10.0007 14.1663C9.54041 14.1663 9.16732 13.7932 9.16732 13.333V10.833H6.66732C6.20708 10.833 5.83398 10.4599 5.83398 9.99968C5.83398 9.53944 6.20708 9.16634 6.66732 9.16634H9.16732V6.66634C9.16732 6.2061 9.54041 5.83301 10.0007 5.83301Z"\n    fill="currentColor"\n  />\n</svg>\n',V='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M14.5 5C13.3954 5 12.5 5.89543 12.5 7C12.5 8.10457 13.3954 9 14.5 9C15.6046 9 16.5 8.10457 16.5 7C16.5 5.89543 15.6046 5 14.5 5ZM10.626 6C11.0701 4.27477 12.6362 3 14.5 3C16.3638 3 17.9299 4.27477 18.374 6H20C20.5523 6 21 6.44772 21 7C21 7.55228 20.5523 8 20 8H18.374C17.9299 9.72523 16.3638 11 14.5 11C12.6362 11 11.0701 9.72523 10.626 8H4C3.44772 8 3 7.55228 3 7C3 6.44772 3.44772 6 4 6H10.626ZM9.5 15C8.39543 15 7.5 15.8954 7.5 17C7.5 18.1046 8.39543 19 9.5 19C10.6046 19 11.5 18.1046 11.5 17C11.5 15.8954 10.6046 15 9.5 15ZM5.62602 16C6.07006 14.2748 7.63616 13 9.5 13C11.3638 13 12.9299 14.2748 13.374 16H20C20.5523 16 21 16.4477 21 17C21 17.5523 20.5523 18 20 18H13.374C12.9299 19.7252 11.3638 21 9.5 21C7.63616 21 6.07006 19.7252 5.62602 18H4C3.44772 18 3 17.5523 3 17C3 16.4477 3.44772 16 4 16H5.62602Z"\n    fill="currentColor"\n  />\n</svg>\n',z='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M11.2929 3.29289C11.6834 2.90237 12.3166 2.90237 12.7071 3.29289L16.7071 7.29289C17.0976 7.68342 17.0976 8.31658 16.7071 8.70711C16.3166 9.09763 15.6834 9.09763 15.2929 8.70711L13 6.41421V15C13 15.5523 12.5523 16 12 16C11.4477 16 11 15.5523 11 15V6.41421L8.70711 8.70711C8.31658 9.09763 7.68342 9.09763 7.29289 8.70711C6.90237 8.31658 6.90237 7.68342 7.29289 7.29289L11.2929 3.29289ZM4 14C4.55228 14 5 14.4477 5 15V18C5 18.5523 5.44772 19 6 19H18C18.5523 19 19 18.5523 19 18V15C19 14.4477 19.4477 14 20 14C20.5523 14 21 14.4477 21 15V18C21 19.6569 19.6569 21 18 21H6C4.34315 21 3 19.6569 3 18V15C3 14.4477 3.44772 14 4 14Z"\n    fill="currentColor"\n  />\n</svg>\n',N='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M7 3.5C7.55228 3.5 8 3.94772 8 4.5V5H9.98469C9.99404 4.99987 10.0034 4.99987 10.0128 5H11.5C12.0523 5 12.5 5.44772 12.5 6C12.5 6.55228 12.0523 7 11.5 7H10.8637C10.5154 8.988 9.81622 10.6517 8.66723 11.9696C8.62438 12.0188 8.58099 12.0674 8.53707 12.1154C9.22032 12.5013 10.0168 12.8033 10.9408 13.0284C11.4774 13.1591 11.8064 13.7001 11.6757 14.2367C11.545 14.7733 11.004 15.1023 10.4674 14.9716C9.10136 14.6388 7.92361 14.1437 6.93184 13.4706C5.88214 14.1537 4.64437 14.6449 3.22613 14.9741C2.68815 15.099 2.15079 14.7641 2.0259 14.2261C1.90101 13.6882 2.23589 13.1508 2.77387 13.0259C3.78086 12.7921 4.63641 12.4768 5.36153 12.0803C4.69058 11.3066 4.15918 10.3915 3.76584 9.32467C3.57479 8.80648 3.83998 8.23153 4.35817 8.04047C4.87635 7.84942 5.4513 8.11461 5.64236 8.63279C5.96391 9.50491 6.39674 10.2474 6.96257 10.8708C7.03019 10.8003 7.09588 10.7286 7.15969 10.6554C7.95291 9.7455 8.51161 8.55536 8.8285 7H2.5C1.94772 7 1.5 6.55228 1.5 6C1.5 5.44772 1.94772 5 2.5 5H6V4.5C6 3.94772 6.44772 3.5 7 3.5ZM17 9C17.3788 9 17.725 9.214 17.8944 9.55279L22.3944 18.5528C22.6414 19.0468 22.4412 19.6474 21.9472 19.8944C21.4532 20.1414 20.8526 19.9412 20.6056 19.4472L19.757 17.75H14.243L13.3944 19.4472C13.1474 19.9412 12.5468 20.1414 12.0528 19.8944C11.5588 19.6474 11.3586 19.0468 11.6056 18.5528L16.1056 9.55279C16.275 9.214 16.6212 9 17 9ZM15.243 15.75H18.757L17 12.2361L15.243 15.75Z"\n    fill="currentColor"\n  />\n</svg>\n',J='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M10.5555 4C10.099 4 9.70052 4.30906 9.58693 4.75114L9.29382 5.8919H14.715L14.4219 4.75114C14.3083 4.30906 13.9098 4 13.4533 4H10.5555ZM16.7799 5.8919L16.3589 4.25342C16.0182 2.92719 14.8226 2 13.4533 2H10.5555C9.18616 2 7.99062 2.92719 7.64985 4.25342L7.22886 5.8919H4C3.44772 5.8919 3 6.33961 3 6.8919C3 7.44418 3.44772 7.8919 4 7.8919H4.10069L5.31544 19.3172C5.47763 20.8427 6.76455 22 8.29863 22H15.7014C17.2354 22 18.5224 20.8427 18.6846 19.3172L19.8993 7.8919H20C20.5523 7.8919 21 7.44418 21 6.8919C21 6.33961 20.5523 5.8919 20 5.8919H16.7799ZM17.888 7.8919H6.11196L7.30423 19.1057C7.3583 19.6142 7.78727 20 8.29863 20H15.7014C16.2127 20 16.6417 19.6142 16.6958 19.1057L17.888 7.8919ZM10 10C10.5523 10 11 10.4477 11 11V16C11 16.5523 10.5523 17 10 17C9.44772 17 9 16.5523 9 16V11C9 10.4477 9.44772 10 10 10ZM14 10C14.5523 10 15 10.4477 15 11V16C15 16.5523 14.5523 17 14 17C13.4477 17 13 16.5523 13 16V11C13 10.4477 13.4477 10 14 10Z"\n    fill="currentColor"\n  />\n</svg>\n',Y='<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM7 7a5 5 0 1 1 10 0A5 5 0 0 1 7 7Zm5 8c-3.656 0-6.5 2.75-6.5 6a1 1 0 1 1-2 0c0-4.482 3.872-8 8.5-8s8.5 3.518 8.5 8a1 1 0 1 1-2 0c0-3.25-2.844-6-6.5-6Z" clip-rule="evenodd"></path></svg>',K='<svg\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  xmlns="http://www.w3.org/2000/svg"\n>\n  <path\n    fill-rule="evenodd"\n    clip-rule="evenodd"\n    d="M14.5 4C11.4624 4 8.99999 6.46243 8.99999 9.5C8.99999 10.2519 9.1503 10.9661 9.42157 11.6162C9.57769 11.9903 9.49247 12.4217 9.2058 12.7084L4.4571 17.4571C3.88112 18.0331 3.88112 18.9669 4.4571 19.5429C5.03307 20.1189 5.96691 20.1189 6.54288 19.5429L11.2916 14.7942C11.5783 14.5075 12.0096 14.4223 12.3838 14.5784C13.0339 14.8497 13.7481 15 14.5 15C17.5376 15 20 12.5376 20 9.5C20 9.47156 19.9998 9.44318 19.9993 9.41486L18.7071 10.7071C17.212 12.2022 14.788 12.2022 13.2929 10.7071C11.7978 9.21201 11.7978 6.78798 13.2929 5.29289L14.5851 4.00064C14.5568 4.00022 14.5284 4 14.5 4ZM6.99999 9.5C6.99999 5.35786 10.3579 2 14.5 2C15.3632 2 16.1943 2.14622 16.9687 2.41606C17.2937 2.52931 17.5376 2.80173 17.6144 3.13722C17.6912 3.47271 17.5901 3.82412 17.3467 4.06748L14.7071 6.70711C13.9931 7.42115 13.9931 8.57885 14.7071 9.29289C15.4211 10.0069 16.5788 10.0069 17.2929 9.29289L19.9325 6.65327C20.1759 6.4099 20.5273 6.30879 20.8628 6.38559C21.1983 6.46239 21.4707 6.70632 21.5839 7.03132C21.8538 7.8057 22 8.63684 22 9.5C22 13.6421 18.6421 17 14.5 17C13.7195 17 12.9654 16.8805 12.256 16.6582L7.9571 20.9571C6.60007 22.3141 4.39991 22.3141 3.04288 20.9571C1.68586 19.6001 1.68586 17.3999 3.04288 16.0429L7.34175 11.744C7.11954 11.0346 6.99999 10.2805 6.99999 9.5Z"\n    fill="currentColor"\n  />\n</svg>\n';var G=Object.defineProperty,X=Object.getOwnPropertyDescriptor,Q=(e,t,s,o)=>{for(var n,i=o>1?void 0:o?X(t,s):t,a=e.length-1;a>=0;a--)(n=e[a])&&(i=(o?n(t,s,i):n(i))||i);return o&&i&&G(t,s,i),i};const ee=500,te=6e5,se=8e3;let oe=class extends i{constructor(){super(),this.conversationString="",this.conversationData=null,this.sharingURL=null,this.dataFileURL=null,this.overrideSharingJSONString=null,this.shouldRenderMarkdown=!1,this.markdownAllowedTags=null,this.markdownAllowedAttributes=null,this.conversationLabel="Conversation",this.conversation=null,this.isEditable=!1,this.focusModeAuthor=[],this.focusModeRecipient=[],this.focusModeContentType=[],this.focusModeExemptedMessageIndexes=new Set,this.deletedMessageIndexes=new Set,this.insertMessageMenuIndex=null,this.showMessageEditorPopover=!1,this.editorFocusedMessage=null,this.editorFocusedMessageIndex=null,this.isConvoMarkedForDeletion=!1,this.hasMessageSharingURLEventListener=!1,this.hasTranslationEventListener=!1,this.isShowingTranslation=!1,this.isTranslating=!1,this.translationProgress="",this.translationSourceLanguage=null,this.customLabels=[],this.customMessageLabels=[],this.effectiveCustomLabels=[],this.effectiveCustomMessageLabels=[],this.customShareButtons=[],this.isResizingMessageMetadata=!1,this.showShareFloatingToolbar=!1,this.shareFloatingToolbarButtons=[{name:"copy-url",tooltip:"Copy sharable URL",svgIcon:Z},{name:"copy-json",tooltip:"Copy conversation JSON",svgIcon:A},{name:"download-json",tooltip:"Download conversation JSON",svgIcon:F},{name:"harmony-render",tooltip:"Render conversation using a harmony renderer",svgIcon:W}],this.cleanupShareFloatingToolbarAutoUpdate=()=>{},this.shareFloatingToolbarRepositionAdded=!1,this.cleanupMessageEditorPopoverAutoUpdate=()=>{},this.messageEditorPopoverRepositionAdded=!1,this.cleanupInsertMessageMenuAutoUpdate=()=>{},this.insertMessageMenuRepositionAdded=!1,this.hasInsertMessageMenuOutsideClickListener=!1,this.hasMessageEditorPopoverOutsideClickListener=!1,this.isShowingMetadata=!1,this.mouseoverMessage=null,this.mouseoverMessageIndex=null,this.isShowingMessageMetadata=!1,this.conversationMaxWidth=null,this.conversationMinWidth=null,this.disableMarkdownButton=!1,this.disableTranslationButton=!1,this.disableShareButton=!1,this.disableMetadataButton=!1,this.disableEditingModeSaveButton=!1,this.disableConversationIDCopyButton=!1,this.isShowingPreferenceWindow=!1,this.euphonyStyleConfig={},this.disableMessageMetadata=!1,this.disableConversationName=!1,this.disablePreferenceButton=!1,this.disableTokenWindow=!1,this.theme="light",this.isDarkTheme=!1,this.toolbarTooltipDebouncer=null,this.shareFloatingToolbarDebouncer=null,this.shareFloatingToolbarDisappearDebouncer=null,this.metadataDisappearDebouncer=null,this.metadataAppearDebouncer=null,this.getMessageByIndex=e=>this.shadowRoot?.querySelector(`#message-${e}`),this.insertMessageMenuWindowPointerDown=e=>{if(null===this.insertMessageMenuIndex)return;const t=this.shadowRoot?.querySelector(".add-message-type-menu"),s=this.shadowRoot?.querySelector(`.add-button[data-message-index="${this.insertMessageMenuIndex}"]`),o=e.composedPath();t&&o.includes(t)||s&&o.includes(s)||(this.closeInsertMessageMenu(),this.requestUpdate())},this.messageEditorPopoverWindowPointerDown=e=>{if(!this.showMessageEditorPopover||null===this.editorFocusedMessageIndex)return;const t=this.shadowRoot?.querySelector("euphony-message-editor-popover"),s=this.shadowRoot?.querySelector(`.edit-button[data-message-index="${this.editorFocusedMessageIndex}"]`),o=e.composedPath();t&&o.includes(t)||s&&o.includes(s)||(this.closeMessageEditorPopover(),this.requestUpdate())},this.metadataMouseDown=()=>{if(!this.messageMetadataOverlay)return void console.error("Message metadata overlay not initialized.");const e=this.messageMetadataOverlay.getBoundingClientRect();this.messageMetadataOverlay.style.width=`${e.width}px`,this.messageMetadataOverlay.style.height=`${e.height}px`,this.messageMetadataOverlay.style.maxHeight="unset",this.messageMetadataOverlay.style.maxWidth="unset",this.isResizingMessageMetadata=!0;const t=()=>{this.isResizingMessageMetadata=!1,window.removeEventListener("mouseup",t)};window.addEventListener("mouseup",t)},this.baseTime=null}updateEffectiveCustomLabels(){const e=this.conversation?.metadata?C(this.conversation):{customLabels:[],customMessageLabels:[]};this.effectiveCustomLabels=[...e.customLabels,...this.customLabels],this.effectiveCustomMessageLabels=[...e.customMessageLabels,...this.customMessageLabels]}addEventListener(e,t,s){"translation-requested"===e&&(this.hasTranslationEventListener=!0),"fetch-message-sharing-url"===e&&(this.hasMessageSharingURLEventListener=!0),super.addEventListener(e,t,s)}firstUpdated(){window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>{window.matchMedia("(prefers-color-scheme: dark)").matches&&"auto"===this.theme?this.isDarkTheme=!0:this.isDarkTheme="dark"===this.theme})}willUpdate(e){if(e.has("conversationString")&&""!==this.conversationString&&(this.conversation=ne(this.conversationString),this.updateEffectiveCustomLabels(),this.resetComponent(),this.bootstrapEmptyConversationForEditorMode()),e.has("conversationData")&&this.conversationData&&(this.conversation=this.conversationData,this.updateEffectiveCustomLabels(),this.resetComponent(),this.bootstrapEmptyConversationForEditorMode()),(e.has("customLabels")||e.has("customMessageLabels"))&&this.updateEffectiveCustomLabels(),e.has("isEditable")&&this.isEditable&&this.bootstrapEmptyConversationForEditorMode(),e.has("theme")&&(window.matchMedia("(prefers-color-scheme: dark)").matches&&"auto"===this.theme?this.isDarkTheme=!0:this.isDarkTheme="dark"===this.theme),e.has("customShareButtons")&&this.customShareButtons.length>0)for(const[e,t]of this.customShareButtons.entries())this.shareFloatingToolbarButtons.filter(e=>e.tooltip==t[0]).length>0||this.shareFloatingToolbarButtons.push({name:`custom-button-${e}`,tooltip:t[0],svgIcon:""===t[2]?z:t[2]})}updated(e){if(e.has("isShowingMetadata")||e.has("conversation")){const e=this.shadowRoot?.querySelector(".messages"),t=this.shadowRoot?.querySelector(".metadata euphony-json-viewer");this.isShowingMetadata?e&&t&&this.updateComplete.then(()=>{const s=e.getBoundingClientRect(),o=t.getBoundingClientRect();if(s.height<o.height){const t=Math.min(ee,o.height+22);e.style.minHeight=`${t}px`}else e.style.minHeight="auto"},()=>{}):e&&(e.style.minHeight="auto")}if(!this.shareFloatingToolbarRepositionAdded){const e=this.shadowRoot?.querySelector(".share-button"),t=this.shadowRoot?.querySelector(".floating-toolbar-share");e&&t&&(this.cleanupShareFloatingToolbarAutoUpdate=h(e,t,()=>{this.updateShareFloatingToolbarPosition(e,t)}),this.shareFloatingToolbarRepositionAdded=!0)}if(this.showMessageEditorPopover&&null!==this.editorFocusedMessageIndex){const t=this.shadowRoot?.querySelector(`.edit-button[data-message-index="${this.editorFocusedMessageIndex}"]`),s=this.shadowRoot?.querySelector("euphony-message-editor-popover");t&&s&&((!this.messageEditorPopoverRepositionAdded||e.has("editorFocusedMessageIndex")||e.has("showMessageEditorPopover"))&&(this.cleanupMessageEditorPopoverAutoUpdate(),this.cleanupMessageEditorPopoverAutoUpdate=h(t,s,()=>{this.updateMessageEditorPopoverPosition(t,s)}),this.messageEditorPopoverRepositionAdded=!0),this.updateMessageEditorPopoverPosition(t,s))}else this.messageEditorPopoverRepositionAdded&&(this.cleanupMessageEditorPopoverAutoUpdate(),this.messageEditorPopoverRepositionAdded=!1);if(null!==this.insertMessageMenuIndex){const t=this.shadowRoot?.querySelector(`.add-button[data-message-index="${this.insertMessageMenuIndex}"]`),s=this.shadowRoot?.querySelector(".add-message-type-menu");t&&s&&((!this.insertMessageMenuRepositionAdded||e.has("insertMessageMenuIndex"))&&(this.cleanupInsertMessageMenuAutoUpdate(),this.cleanupInsertMessageMenuAutoUpdate=h(t,s,()=>{this.updateInsertMessageMenuPosition(t,s)}),this.insertMessageMenuRepositionAdded=!0),this.updateInsertMessageMenuPosition(t,s))}else this.insertMessageMenuRepositionAdded&&(this.cleanupInsertMessageMenuAutoUpdate(),this.insertMessageMenuRepositionAdded=!1);if(e.has("insertMessageMenuIndex")&&(null===this.insertMessageMenuIndex||this.hasInsertMessageMenuOutsideClickListener?null===this.insertMessageMenuIndex&&this.hasInsertMessageMenuOutsideClickListener&&(window.removeEventListener("pointerdown",this.insertMessageMenuWindowPointerDown),this.hasInsertMessageMenuOutsideClickListener=!1):(window.addEventListener("pointerdown",this.insertMessageMenuWindowPointerDown),this.hasInsertMessageMenuOutsideClickListener=!0)),e.has("showMessageEditorPopover")||e.has("editorFocusedMessageIndex")){const e=this.showMessageEditorPopover&&null!==this.editorFocusedMessageIndex;e&&!this.hasMessageEditorPopoverOutsideClickListener?(window.addEventListener("pointerdown",this.messageEditorPopoverWindowPointerDown),this.hasMessageEditorPopoverOutsideClickListener=!0):!e&&this.hasMessageEditorPopoverOutsideClickListener&&(window.removeEventListener("pointerdown",this.messageEditorPopoverWindowPointerDown),this.hasMessageEditorPopoverOutsideClickListener=!1)}}async initData(){}refreshBaseTime(){if(this.baseTime=null,this.conversation){if(this.conversation.create_time)return void(this.baseTime=this.conversation.create_time);for(const e of this.conversation.messages)if(e.create_time)return void(this.baseTime=e.create_time)}}resetComponent(){this.refreshBaseTime(),this.isShowingTranslation=!1,this.isTranslating=!1,this.translationProgress="",this.translationSourceLanguage=null,this.deletedMessageIndexes=new Set,this.focusModeExemptedMessageIndexes=new Set,this.closeInsertMessageMenu(),this.closeMessageEditorPopover(),this.mouseoverMessage=null,this.mouseoverMessageIndex=null,this.isShowingMessageMetadata=!1,this.isResizingMessageMetadata=!1,null!==this.metadataDisappearDebouncer&&(clearTimeout(this.metadataDisappearDebouncer),this.metadataDisappearDebouncer=null),null!==this.metadataAppearDebouncer&&(clearTimeout(this.metadataAppearDebouncer),this.metadataAppearDebouncer=null),this.messageEditorPopoverRepositionAdded&&(this.cleanupMessageEditorPopoverAutoUpdate(),this.messageEditorPopoverRepositionAdded=!1),this.insertMessageMenuRepositionAdded&&(this.cleanupInsertMessageMenuAutoUpdate(),this.insertMessageMenuRepositionAdded=!1)}getEditedConversationData(){if(null===this.conversation)throw new Error("Conversation is not set");if(this.isConvoMarkedForDeletion)return null;const e=structuredClone(this.conversation);return e.messages=e.messages.filter((e,t)=>!this.deletedMessageIndexes.has(t)),e}serializeConversation(e=null){const t=this.getEditedConversationData();if(null===t)return"null";let s="";return s=e?JSON.stringify(t,null,e):JSON.stringify(t),s}updateShareFloatingToolbarPosition(e,t){b(e,t,"top",3)}updateInsertMessageMenuPosition(e,t){b(e,t,"right",6)}updateMessageEditorPopoverPosition(e,t){b(e,t,"right",10)}bootstrapEmptyConversationForEditorMode(){!this.isEditable||null===this.conversation||this.conversation.messages.length>0||(this.conversation.messages.push({role:p.User,content:[{text:""}]}),this.deletedMessageIndexes.add(0))}async translationButtonClicked(){if(null===this.conversation)return;const e=new CustomEvent("translation-button-clicked",{bubbles:!0,composed:!0});if(this.dispatchEvent(e),this.isShowingTranslation)return void(this.isShowingTranslation=!1);if(void 0!==this.conversation.translatedMessages)return void(this.isShowingTranslation=!0);this.isTranslating=!0;const t=structuredClone(this.conversation.messages),s=async(e,s)=>{const o=[],n=u(e.content),i=m(e.content);switch(n){case"text":{const e=i;o.push({text:e.text,index:0,type:"string"});break}case"developer":{const e=i;if(e.instructions){const t=[e.instructions];if(t.length>0)for(const[e,s]of t.entries())o.push({text:s,index:e,type:"string"})}break}default:throw new Error(`Unsupported message content type for message: ${n}`)}const a=[];for(const e of o){const{promise:t,resolve:s,reject:o}=Promise.withResolvers(),n=t.then(t=>({...t,partIndex:e.index,partContentType:e.type})).catch(t=>(console.error("Translation failed for a conversation part, falling back to original text.",t),{translation:e.text,is_translated:!1,language:"Failed",has_command:!1,partIndex:e.index,partContentType:e.type})),i=window.setTimeout(()=>{o("Timeout")},te),r=e=>{clearTimeout(i),s(e)},l=e=>{clearTimeout(i),o(e)},d=new CustomEvent("translation-requested",{bubbles:!0,composed:!0,detail:{text:e.text,resolve:r,reject:l}});this.dispatchEvent(d),a.push(n)}const r=await Promise.all(a);if(r.some(e=>e.is_translated)){const e=t[s],o=u(e.content);e.isTranslated=!0;for(const[t,s]of r.entries()){const t=m(e.content);if(s.is_translated)switch(o){case"text":"text"in t?t.text=s.translation:"content"in t&&(t.content=s.translation);break;case"developer":{const e=t;e.instructions&&(e.instructions=s.translation);break}default:throw new Error(`Unsupported message content type for translated message: ${o}`)}}}return r},o=[];for(const[e,t]of this.conversation.messages.entries()){const n=u(t.content);if("text"===n||"developer"===n){const n=[t.content[0]],i={...t,content:n};o.push(s(i,e))}}let n=0;const i=o.length,a=await Promise.all(o.map(e=>e.then(e=>(n++,this.translationProgress=i>0?`(${Math.round(n/i*100)}%)`:"",e))));let r=!1;for(const e of a){for(const t of e)if(t.is_translated){r=!0,this.translationSourceLanguage=t.language;break}if(r)break}if(this.isTranslating=!1,this.translationProgress="",r){this.conversation.translatedMessages=t,this.isShowingTranslation=!0;const e=new CustomEvent("translation-completed",{bubbles:!0,composed:!0,detail:{translatedMessages:t}});this.dispatchEvent(e)}else this.conversation.translatedMessages=void 0}toolButtonMouseEnter(e,t,s){if(e.stopPropagation(),e.preventDefault(),!this.popperTooltip)return void console.error("Popper tooltip not initialized.");const o=e.currentTarget;this.toolbarTooltipDebouncer&&clearTimeout(this.toolbarTooltipDebouncer),this.toolbarTooltipDebouncer=window.setTimeout(()=>{const e=this.popperTooltip.querySelector(".popper-label");let n="Button";switch(t){case"markdown":n="Markdown rendering";break;case"translate":n="Translate the conversation";break;case"share":n="Copy a sharable URL";break;case"metadata":n="Show conversation metadata";break;case"delete":n="Delete this message";break;case"add":n="Insert a new message";break;case"edit":n="Focus editable fields";break;case"reorder-up":n="Move message up";break;case"reorder-down":n="Move message down";break;case"preference":n="Customize display";break;case"custom-label":if(void 0===s)return void console.error("maybeTooltipText is not set");n=s;break;case"message-share":n="Copy a sharable URL for this message"}e.textContent=n,v(this.popperTooltip,o,"top",!0,7),this.popperTooltip.classList.remove("hidden")},500)}toolButtonMouseLeave(e=!0){this.popperTooltip?(this.toolbarTooltipDebouncer&&(clearTimeout(this.toolbarTooltipDebouncer),this.toolbarTooltipDebouncer=null),e?this.popperTooltip.classList.add("hidden"):(this.popperTooltip.classList.add("no-transition"),this.popperTooltip.classList.add("hidden"),setTimeout(()=>{this.popperTooltip.classList.remove("no-transition")},150))):console.error("popperTooltip are not initialized yet.")}shareButtonMouseEnter(){this.shareFloatingToolbarDebouncer&&(clearTimeout(this.shareFloatingToolbarDebouncer),this.shareFloatingToolbarDebouncer=null),this.shareFloatingToolbarDisappearDebouncer&&(clearTimeout(this.shareFloatingToolbarDisappearDebouncer),this.shareFloatingToolbarDisappearDebouncer=null),this.shareFloatingToolbarDebouncer=window.setTimeout(()=>{this.showShareFloatingToolbar=!0},500)}shareButtonMouseLeave(){this.shareFloatingToolbarDebouncer&&(clearTimeout(this.shareFloatingToolbarDebouncer),this.shareFloatingToolbarDebouncer=null),this.shareFloatingToolbarDisappearDebouncer=window.setTimeout(()=>{this.showShareFloatingToolbar=!1},600)}async shareFloatingToolbarButtonClicked(e){if(!this.shareFloatingToolbar)return void console.error("Share floating toolbar not initialized");const t=e.detail;switch(t){case"copy-url":if(!this.sharingURL)return void console.error("Sharing URL is not set");await navigator.clipboard.writeText(this.sharingURL),this.shareFloatingToolbar.updateCurrentTooltip("Copied");break;case"copy-json":{let e=this.serializeConversation(2);this.overrideSharingJSONString&&(e=this.overrideSharingJSONString),await navigator.clipboard.writeText(e),this.shareFloatingToolbar.updateCurrentTooltip("Copied");break}case"download-json":{let e=this.serializeConversation(2);this.overrideSharingJSONString&&(e=this.overrideSharingJSONString),c(e,null,"euphony-conversation.json"),this.shareFloatingToolbar.updateCurrentTooltip("Downloaded");break}case"harmony-render":{if(!this.tokenWindowComponent)return void console.error("Token window component not initialized");const e=this.serializeConversation();if(this.disableTokenWindow){const t=new CustomEvent("harmony-render-button-clicked",{bubbles:!0,composed:!0,detail:e});this.dispatchEvent(t)}else this.tokenWindowComponent.show(e);break}default:if(t.includes("custom-button")){const e=parseInt(t.split("-")[2]);if(e>=this.customShareButtons.length)return void console.error("Custom button index is out of range:",e);const s=this.customShareButtons[e][1];s&&window.open(s,"_blank")}else console.error("Unsupported button name:",t)}}metadataButtonClicked(){this.toolButtonMouseLeave(!1);const e=new CustomEvent("conversation-metadata-button-toggled",{bubbles:!0,composed:!0,detail:!this.isShowingMetadata});this.isShowingMetadata=!this.isShowingMetadata,this.dispatchEvent(e)}markdownButtonClicked(){const e=new CustomEvent("markdown-button-toggled",{bubbles:!0,composed:!0,detail:!this.shouldRenderMarkdown});this.shouldRenderMarkdown=!this.shouldRenderMarkdown,this.dispatchEvent(e)}editingSaveButtonClicked(){const e=this.serializeConversation(),t=new CustomEvent("editing-save-button-clicked",{bubbles:!0,composed:!0,detail:e});this.dispatchEvent(t)}swapDeletedMessageIndexes(e,t){const s=new Set(this.deletedMessageIndexes),o=s.has(e),n=s.has(t);o&&s.delete(e),n&&s.delete(t),o&&s.add(t),n&&s.add(e),this.deletedMessageIndexes=s}shiftDeletedIndexesAfterInsert(e){const t=new Set;for(const s of this.deletedMessageIndexes)t.add(s>=e?s+1:s);this.deletedMessageIndexes=t}reorderUpButtonClicked(e){if(!this.conversation||e<=0)return;const t=this.conversation.messages;[t[e-1],t[e]]=[t[e],t[e-1]],this.swapDeletedMessageIndexes(e-1,e),this.closeMessageEditorPopover(),this.requestUpdate()}reorderDownButtonClicked(e){if(!this.conversation||e>=this.conversation.messages.length-1)return;const t=this.conversation.messages;[t[e],t[e+1]]=[t[e+1],t[e]],this.swapDeletedMessageIndexes(e,e+1),this.closeMessageEditorPopover(),this.requestUpdate()}createEmptyMessageForContentType(e,t){if("system"===t){const e=(new Date).toISOString().slice(0,10);return{role:p.System,content:[{model_identity:"You are ChatGPT, a large language model trained by OpenAI.",conversation_start_date:e,knowledge_cutoff:"2024-06",channel_config:{valid_channels:["analysis","commentary","final"],channel_required:!0}}]}}return"developer"===t?{role:p.Developer,content:[{instructions:""}]}:{role:e?.role??p.User,content:[{text:""}]}}async insertMessageAfterIndex(e,t){if(!this.conversation)return;const s=this.conversation.messages[e],o=this.createEmptyMessageForContentType(s,t),n=e+1;this.conversation.messages.splice(n,0,o),this.shiftDeletedIndexesAfterInsert(n),this.closeMessageEditorPopover(),this.insertMessageMenuIndex=null,this.requestUpdate(),await this.updateComplete,this.focusEditableFieldsForMessage(n)}closeInsertMessageMenu(){this.insertMessageMenuIndex=null}messageEditorAddMessageButtonClicked(e){this.insertMessageMenuIndex!==e?(this.closeMessageEditorPopover(),this.insertMessageMenuIndex=e,this.requestUpdate()):this.closeInsertMessageMenu()}closeMessageEditorPopover(){this.showMessageEditorPopover=!1,this.editorFocusedMessage=null,this.editorFocusedMessageIndex=null}messageEditorEditButtonClicked(e){if(this.conversation){if(this.showMessageEditorPopover&&this.editorFocusedMessageIndex===e)return this.closeMessageEditorPopover(),void this.requestUpdate();this.closeInsertMessageMenu(),this.editorFocusedMessageIndex=e,this.editorFocusedMessage=this.conversation.messages[e]??null,this.showMessageEditorPopover=!!this.editorFocusedMessage,this.messageEditorPopoverRepositionAdded=!1,this.requestUpdate()}}messageEditorPopoverSaveButtonClicked(e){if(!this.editorFocusedMessage)return;const t=e.detail;this.editorFocusedMessage.role=t.role,this.editorFocusedMessage.name=t.name,this.editorFocusedMessage.recipient=t.recipient,this.editorFocusedMessage.channel=t.channel,this.closeMessageEditorPopover(),this.requestUpdate()}messageEditorPopoverCancelButtonClicked(){this.closeMessageEditorPopover(),this.requestUpdate()}focusEditableFieldsForMessage(e){const t=this.shadowRoot?.querySelector(`#message-${e}`);if(!t)return;const s=t.querySelector('[contenteditable="true"]');if(!s)return;s.focus();const o=window.getSelection();if(!o)return;const n=document.createRange();n.selectNodeContents(s),n.collapse(!1),o.removeAllRanges(),o.addRange(n)}preferenceButtonClicked(){this.isShowingPreferenceWindow=!this.isShowingPreferenceWindow}messageInfoMouseEnter(e,t,s){if(this.disableMessageMetadata)return;if(!this.messageMetadataOverlay)return void console.error("Message metadata overlay not initialized.");this.metadataDisappearDebouncer&&(clearTimeout(this.metadataDisappearDebouncer),this.metadataDisappearDebouncer=null),this.metadataAppearDebouncer&&(clearTimeout(this.metadataAppearDebouncer),this.metadataAppearDebouncer=null);const o=e.currentTarget;o.classList.add("is-hovered");const n=this.isShowingMessageMetadata?0:300;this.messageMetadataOverlay.scrollTo({top:0,behavior:"instant"}),this.metadataAppearDebouncer=window.setTimeout(()=>{this.mouseoverMessage=t,this.mouseoverMessageIndex=s,v(this.messageMetadataOverlay,o,"left",!0,7),this.isShowingMessageMetadata=!0},n)}messageInfoMouseLeave(){this.messageMetadataOverlay?(this.metadataAppearDebouncer&&(clearTimeout(this.metadataAppearDebouncer),this.metadataAppearDebouncer=null),this.shadowRoot.querySelector(".message-info.is-hovered").classList.remove("is-hovered"),this.metadataDisappearDebouncer=window.setTimeout(()=>{this.isShowingMessageMetadata=!1},500)):console.error("Message metadata overlay not initialized.")}metadataOverlayMouseEnter(){this.messageMetadataOverlay?(this.metadataDisappearDebouncer&&(clearTimeout(this.metadataDisappearDebouncer),this.metadataDisappearDebouncer=null),this.shadowRoot.querySelector(`#message-info-${this.mouseoverMessageIndex}`).classList.add("is-hovered"),this.isShowingMessageMetadata=!0):console.error("Message metadata overlay not initialized.")}metadataOverlayMouseLeave(){this.messageMetadataOverlay?this.isResizingMessageMetadata||(this.shadowRoot.querySelector(".message-info.is-hovered").classList.remove("is-hovered"),this.metadataDisappearDebouncer=window.setTimeout(()=>{this.isShowingMessageMetadata=!1},500)):console.error("Message metadata overlay not initialized.")}metadataOverlayShareButtonClicked(e,t){if(!this.sharingURL)return void console.error("Sharing URL is not set");const s=e.currentTarget,{promise:o,resolve:n,reject:i}=w(1e3);o.then(async e=>{await navigator.clipboard.writeText(e),this.popperTooltip.querySelector(".popper-label").textContent="Copied",v(this.popperTooltip,s,"top",!0,7)}).catch(()=>{});const a=new CustomEvent("fetch-message-sharing-url",{bubbles:!0,composed:!0,detail:{messageIndex:t,resolve:n,reject:i}});this.dispatchEvent(a)}loadKatexScript(){if(!("katex"in window)){const e=document.createElement("script");if(e.src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js",e.defer=!0,e.integrity="sha384-Rma6DA2IPUwhNxmrB/7S3Tno0YY7sFu9WSYMCuulLhIqYSGZ2gKCJWIqhBWqMQfh",e.crossOrigin="anonymous",!document.querySelector('link[href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css"]')){const e=document.createElement("link");e.rel="stylesheet",e.href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css",e.integrity="sha384-zh0CIslj+VczCZtlzBcjt5ppRcsAmDnRem7ESsYwWwg3m/OaJ2l4x7YBZl9Kxxib",e.crossOrigin="anonymous",document.head.appendChild(e)}return e}}preferenceWindowMaxMessageHeightChanged(e){const t=e.detail;this.euphonyStyleConfig["--max-message-height"]=t,this.requestUpdate()}preferenceWindowFocusModeSettingsChanged(e){const t=e.detail;this.focusModeAuthor=[...t.author],this.focusModeRecipient=[...t.recipient],this.focusModeContentType=[...t.contentType]}preferenceWindowMessageLabelChanged(e){e.detail.absoluteTimestamp?(this.euphonyStyleConfig["--message-label-absolute-timestamp-display"]="block",this.euphonyStyleConfig["--message-label-relative-timestamp-display"]="none"):(delete this.euphonyStyleConfig["--message-label-absolute-timestamp-display"],delete this.euphonyStyleConfig["--message-label-relative-timestamp-display"]),this.requestUpdate()}async allChildrenUpdateComplete(){await this.updateComplete;const e=["euphony-message-text"],t=[];for(const s of e){const e=this.shadowRoot?.querySelectorAll(s);e&&e.forEach(e=>{t.push(e.updateComplete)})}await Promise.all(t)}relativeTimestampFormatter(e){if(null===this.baseTime)return console.error("Base time is not set"),"";const t=Math.max(0,Math.floor(e)-this.baseTime);let s=t;const o=[],n=[["d",86400],["h",3600],["m",60],["s",1]];for(const[e,i]of n){if(t<i&&i>1)continue;const n=Math.floor(s/i);s%=i,o.push(`${n}${e}`)}return o.join(" ")}absoluteTimestampFormatter(e){const t=new Date(1e3*e);return`${t.getFullYear()}-${(t.getMonth()+1).toString().padStart(2,"0")}-${t.getDate().toString().padStart(2,"0")} ${t.getHours().toString().padStart(2,"0")}:${t.getMinutes().toString().padStart(2,"0")}:${t.getSeconds().toString().padStart(2,"0")}`}getAuthorIcon(e){let t=a`<span class="role-icon"
      >${r(Y)}</span
    >`;switch(e){case p.Assistant:t=a`<span class="role-icon svg-icon"
          >${r(R)}</span
        >`;break;case p.User:t=a`<span class="role-icon svg-icon"
          >${r(Y)}</span
        >`;break;case p.System:t=a`<span class="role-icon svg-icon"
          >${r(V)}</span
        >`;break;case p.Tool:t=a`<span class="role-icon svg-icon"
          >${r(K)}</span
        >`;break;case p.Developer:t=a`<span class="role-icon svg-icon"
          >${r(O)}</span
        >`;break;default:console.warn("Unsupported role:",e)}return t}isMessageHiddenByFocusMode(e,t){if(this.focusModeExemptedMessageIndexes.has(t))return!1;if(this.focusModeAuthor.length>0&&!this.focusModeAuthor.includes(e.role)||this.focusModeRecipient.length>0&&!this.focusModeRecipient.includes(e.recipient??""))return!0;if(this.focusModeContentType.length>0){const t=g(e.content);if(null===t||!this.focusModeContentType.includes(t))return!0}return!1}getMessageContentTemplate(e,t){if(null===this.conversation)throw new Error("Conversation is not set");const s=`message-${t}`,o=this.isMessageHiddenByFocusMode(e,t)?"display: none;":"";let n=a``;const i=g(e.content);switch(i){case"text":n=a`
          <euphony-message-text
            .message=${e}
            id=${s}
            style=${o}
            ?shouldRenderMarkdown=${this.shouldRenderMarkdown}
            .markdownAllowedTags=${this.markdownAllowedTags}
            .markdownAllowedAttributes=${this.markdownAllowedAttributes}
            ?isEditable=${this.isEditable}
            ?isTranslation=${this.isShowingTranslation&&this.conversation.translatedMessages&&e.isTranslated}
            @message-text-changed=${e=>{const s=this.conversation.messages[t];if("string"==typeof s.content)return void(s.content=e.detail);const o=s.content[0];o?"text"in o?o.text=e.detail:o.content=e.detail:s.content=[{text:e.detail}]}}
          ></euphony-message-text>
        `;break;case"code":n=a`
          <euphony-message-code
            .message=${e}
            id=${s}
            style=${o}
          ></euphony-message-code>
        `;break;case"system":n=a`
          <euphony-message-system-content
            .message=${e}
            id=${s}
            style=${o}
            ?shouldRenderMarkdown=${this.shouldRenderMarkdown}
            .markdownAllowedTags=${this.markdownAllowedTags}
            .markdownAllowedAttributes=${this.markdownAllowedAttributes}
            ?isEditable=${this.isEditable}
            ?isTranslation=${this.isShowingTranslation&&this.conversation.translatedMessages&&e.isTranslated}
            .dataFileURL=${this.dataFileURL}
            @message-system-content-changed=${e=>{const s=this.conversation.messages[t].content[0],{location:o,newContent:n}=e.detail;switch(o){case"model_identity":s.model_identity=n;break;case"conversation_start_date":s.conversation_start_date=n;break;case"knowledge_cutoff":s.knowledge_cutoff=n;break;case"valid_channels":s.channel_config&&(s.channel_config.valid_channels=n.split(",").map(e=>e.trim()).filter(Boolean));break;case"channel_required":s.channel_config&&(s.channel_config.channel_required="true"===n.trim().toLowerCase());break;default:console.warn("Unsupported system edit location:",o)}}}
          ></euphony-message-system-content>
        `;break;case"developer":n=a`
          <euphony-message-developer-content
            .message=${e}
            id=${s}
            style=${o}
            ?shouldRenderMarkdown=${this.shouldRenderMarkdown}
            .markdownAllowedTags=${this.markdownAllowedTags}
            .markdownAllowedAttributes=${this.markdownAllowedAttributes}
            ?isEditable=${this.isEditable}
            @message-developer-content-changed=${e=>{const s=this.conversation.messages[t].content[0],{location:o,index:n,newContent:i}=e.detail;switch(o){case"instruction":s.instructions=i;break;case"tool_namespace_name":s.tools&&"string"==typeof n&&(s.tools[n].name=i);break;case"tool_namespace_description":s.tools&&"string"==typeof n&&(s.tools[n].description=i);break;default:console.warn("Unsupported developer edit location:",o)}}}
          ></euphony-message-developer-content>
        `;break;default:console.error("Unsupported message content type:",i),n=a`
          <euphony-message-unsupported
            .message=${e}
            id=${s}
            style=${o}
          ></euphony-message-unsupported>
        `}return this.isEditable&&(n=a`<div
        class="editable-message"
        style=${o}
        ?is-deleted=${this.deletedMessageIndexes.has(t)}
      >
        ${n}
        <div class="action-group">
          <div class="action-item">
            <button
              class="svg-icon reorder-up-button"
              ?disabled=${0===t}
              @mouseenter=${e=>{this.toolButtonMouseEnter(e,"reorder-up")}}
              @mouseleave=${()=>{this.toolButtonMouseLeave()}}
              @click=${()=>{this.reorderUpButtonClicked(t)}}
            >
              ${r(P)}
            </button>

            <button
              class="svg-icon add-button"
              data-message-index=${t}
              ?is-activated=${this.insertMessageMenuIndex===t}
              @mouseenter=${e=>{this.toolButtonMouseEnter(e,"add")}}
              @mouseleave=${()=>{this.toolButtonMouseLeave()}}
              @click=${()=>{this.toolButtonMouseLeave(),this.messageEditorAddMessageButtonClicked(t)}}
            >
              ${r(q)}
            </button>

            <button
              class="svg-icon reorder-down-button"
              ?disabled=${t===this.conversation.messages.length-1}
              @mouseenter=${e=>{this.toolButtonMouseEnter(e,"reorder-down")}}
              @mouseleave=${()=>{this.toolButtonMouseLeave()}}
              @click=${()=>{this.reorderDownButtonClicked(t)}}
            >
              ${r(P)}
            </button>
          </div>

          <div class="action-item">
            <button
              class="svg-icon delete-button action-item"
              @mouseenter=${e=>{this.toolButtonMouseEnter(e,"delete")}}
              @mouseleave=${()=>{this.toolButtonMouseLeave()}}
              @click=${()=>{this.deletedMessageIndexes.has(t)?this.deletedMessageIndexes.delete(t):this.deletedMessageIndexes.add(t),this.requestUpdate()}}
            >
              ${r(J)}
            </button>

            <button
              class="svg-icon edit-button action-item"
              data-message-index=${t}
              ?is-activated=${this.showMessageEditorPopover&&this.editorFocusedMessageIndex===t}
              @mouseenter=${e=>{this.toolButtonMouseEnter(e,"edit")}}
              @mouseleave=${()=>{this.toolButtonMouseLeave()}}
              @click=${()=>{this.toolButtonMouseLeave(),this.messageEditorEditButtonClicked(t)}}
            >
              ${r(j)}
            </button>
          </div>
        </div>
      </div>`),n}renderTextWithWordBreaks(e){return e.split(/([_.-])/g).map(e=>"_"===e||"-"===e||"."===e?a`${e}<wbr>`:a`${e}`)}getMessageMetadataInfo(e){let t=a``;return e.name&&(t=a`${t}
        <span class="message-metadata-info-tag"
          >author: ${e.name}</span
        > `),e.create_time&&(t=a`${t}
        <span class="message-metadata-info-tag"
          >created: ${s=e.create_time,new Date(1e3*s).toLocaleString("en-US",{month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}</span
        > `),e.recipient&&(t=a`${t}
        <span class="message-metadata-info-tag"
          >recipient: ${e.recipient}</span
        > `),e.channel&&(t=a`${t}
        <span class="message-metadata-info-tag"
          >channel: ${e.channel}</span
        > `),t;var s}render(){let e=a``,t=a``,s=a``;if(this.conversation){let o=a``;this.isShowingTranslation&&this.translationSourceLanguage&&(o=a`<div class="translation-label">
          Translated from ${this.translationSourceLanguage}
        </div>`);const n=a`
        <button
          class="icon svg-icon share-button"
          ?is-hidden=${this.disableShareButton}
          ?is-activated=${this.showShareFloatingToolbar}
          @mouseenter=${()=>{this.shareButtonMouseEnter()}}
          @mouseleave=${()=>{this.shareButtonMouseLeave()}}
        >
          ${r(z)}
        </button>
      `;let i=a``;for(const e of this.effectiveCustomLabels){let t=e=>{},s=()=>{};const o={};e.length>=4&&(o["--custom-label-color"]=`${e[3]};`),e.length>=3&&""!==e[2]&&(t=t=>{this.toolButtonMouseEnter(t,"custom-label",e[2])},s=()=>{this.toolButtonMouseLeave()});let n=a``;n=e.length>=2&&""!==e[1]?a`
            <div class="label-name">${e[0]}:</div>
            <div class="label-text">${e[1]}</div>
          `:a` <div class="label-name">${e[0]}</div> `,i=a`${i}
          <div
            class="custom-label"
            style=${M(o)}
            @mouseenter=${t}
            @mouseleave=${s}
          >
            ${n}
          </div>`}let l=a``;this.isEditable&&!this.disableEditingModeSaveButton&&(l=a`<button
          class="text-button"
          @click=${()=>{this.editingSaveButtonClicked()}}
        >
          Save
        </button>`),e=a`<div
        class="header"
        ?is-showing-metadata=${this.isShowingMetadata}
      >
        <div
          class="label-group"
          ?is-hidden=${this.disableConversationName}
          ?no-show=${this.disableConversationName&&this.disableShareButton&&this.disableMarkdownButton&&this.disableTranslationButton&&this.disableMetadataButton}
        >
          <div class="conversation-label-group">
            <span class="conversation-label">${this.conversationLabel}:</span>
            <span class="conversation-id" title=${this.conversation.id??""}
              >${this.conversation.id?.slice(0,8)??""}</span
            >
            <sl-copy-button
              value=${this.conversation.id??""}
              size="small"
              copy-label="Copy conversation ID"
              hoist
              ?is-hidden=${this.disableConversationIDCopyButton}
            >
            </sl-copy-button>
          </div>

          <div class="loader-container" ?is-loading=${this.isTranslating}>
            <div class="loader-label">
              Translating ${this.translationProgress}
            </div>
            <div class="loader"></div>
          </div>
          ${l} ${o} ${i}
        </div>

        <div class="action-group">
          <button
            class="icon svg-icon preference-button"
            ?is-active=${this.isShowingPreferenceWindow}
            ?is-hidden=${this.disablePreferenceButton}
            @click=${()=>{this.preferenceButtonClicked()}}
            @mouseenter=${e=>{this.toolButtonMouseEnter(e,"preference")}}
            @mouseleave=${()=>{this.toolButtonMouseLeave()}}
          >
            ${r(V)}
          </button>

          <button
            class="icon svg-icon markdown-button"
            ?is-active=${this.shouldRenderMarkdown}
            ?is-hidden=${this.isEditable||this.disableMarkdownButton}
            @click=${()=>{this.markdownButtonClicked()}}
            @mouseenter=${e=>{this.toolButtonMouseEnter(e,"markdown")}}
            @mouseleave=${()=>{this.toolButtonMouseLeave()}}
          >
            ${this.shouldRenderMarkdown?r(H):r(U)}
          </button>

          <button
            class="icon svg-icon translate-button"
            ?disabled=${this.isTranslating}
            ?is-active=${this.isShowingTranslation||this.isTranslating}
            ?is-hidden=${this.isEditable||this.disableTranslationButton||!this.hasTranslationEventListener}
            @mouseenter=${e=>{this.toolButtonMouseEnter(e,"translate")}}
            @mouseleave=${()=>{this.toolButtonMouseLeave()}}
            @click=${()=>{this.translationButtonClicked().then(()=>{},()=>{})}}
          >
            ${r(N)}
          </button>

          <button
            class="icon svg-icon metadata-button"
            ?is-active=${this.isShowingMetadata}
            ?is-hidden=${this.disableMetadataButton}
            @click=${()=>{this.metadataButtonClicked()}}
            @mouseenter=${e=>{this.toolButtonMouseEnter(e,"metadata")}}
            @mouseleave=${()=>{this.toolButtonMouseLeave()}}
          >
            ${r(_)}
          </button>

          ${n}
        </div>
      </div>`;let d=this.conversation.messages;if(this.isShowingTranslation&&this.conversation.translatedMessages&&(d=this.conversation.translatedMessages),d.length>se){const e={role:p.Tool,name:"Euphony",content:[{text:`This conversation is truncated to 8000 messages from the bottom (total: ${d.length}).`}],recipient:"all",channel:void 0,metadata:{}};d=[e,...d.slice(0,se),e]}for(const[e,s]of d.entries()){const o=s.role,n=this.getAuthorIcon(o);let l=a``;s.name&&(l=a`<span class="label label-text"
            ><span class="name-text" title=${s.name}
              >${this.renderTextWithWordBreaks(s.name)}</span
            ></span
          >`);let d=a``;null!==this.baseTime&&s.create_time&&e>0&&(d=a`<div
            class="label label-text label-relative-timestamp"
          >
            ${this.relativeTimestampFormatter(s.create_time)}
          </div>`);let h=a``;s.create_time&&(h=a`<div
            class="label label-text label-absolute-timestamp"
          >
            ${this.absoluteTimestampFormatter(s.create_time)}
          </div>`);const c=a` <span class="arrow svg-icon"
          >${r(I)}
        </span>`;let u=a``;const g=new Set(["all"]);s.recipient&&!g.has(s.recipient)&&(u=a`
            <span class="label label-text">
              ${c}<span class="recipient-text" title=${s.recipient}
                >${this.renderTextWithWordBreaks(s.recipient)}</span
              ></span
            >
          `);let m=a``;void 0!==s.channel&&null!==s.channel&&(m=a`
            <span class="label label-text channel">
              ${c}<span class="channel-text">${s.channel}</span></span
            >
          `);let v=a``;const C={},b=this.effectiveCustomMessageLabels.filter(t=>"number"==typeof t[0]&&t[0]===e);if(b.length>0){const e=[];for(const t of b){const s=e=>{this.toolButtonMouseEnter(e,"custom-label",t[1])},o=()=>{this.toolButtonMouseLeave()},n={};t.length>=3&&(n["--custom-label-color"]=`${t[2]};`),i=a`<div
              class="custom-label"
              style=${M(n)}
              @mouseenter=${s}
              @mouseleave=${o}
            >
              ${t[3]}
            </div>`,e.push(i)}v=a`<div class="custom-labels">
            ${e}
          </div>`,C["--message-content-border"]=`3px solid ${b[0][2]};`,C["--message-content-border-left"]=`3px solid ${b[0][2]};`,C["--message-content-border-radius"]="4px;",C["--conv-background-color"]=`color-mix(\n            in lab, ${b[0][2]} 7%, transparent 100%);`}const w=this.getMessageContentTemplate(s,e),y=this.isMessageHiddenByFocusMode(s,e)?a`<euphony-message-hidden
              .message=${s}
              @hidden-message-clicked=${()=>{this.focusModeExemptedMessageIndexes=new Set(this.focusModeExemptedMessageIndexes).add(e)}}
            ></euphony-message-hidden>`:a``;t=a`${t}
          <div
            class="message"
            ?is-user=${o===p.User}
            ?is-assistant=${o===p.Assistant}
            style=${M(C)}
          >
            <div
              class="message-info"
              id=${`message-info-${e}`}
              tabindex=${1}
              @mouseenter=${t=>{this.messageInfoMouseEnter(t,s,e)}}
              @mouseleave=${()=>{this.messageInfoMouseLeave()}}
            >
              <div class="author">${n}</div>
              ${d} ${h} ${l}
              ${u} ${m} ${v}
            </div>

            ${w} ${y}
          </div> `}s=a`<euphony-json-viewer
        .data=${this.conversation.metadata}
        ?is-dark-theme=${this.isDarkTheme}
      >
      </euphony-json-viewer>`}const o=a`
      <div
        id="popper-tooltip"
        class="popper-tooltip hidden"
        role="tooltip"
        @click=${e=>{e.stopPropagation()}}
      >
        <div class="popper-content">
          <span class="popper-label">Hello</span>
        </div>
        <div class="popper-arrow"></div>
      </div>
    `;let n=structuredClone(this.shareFloatingToolbarButtons);this.sharingURL||(n=n.filter(e=>"copy-url"!==e.name));const i=a`
      <euphony-floating-toolbar
        ?is-hidden=${!this.showShareFloatingToolbar}
        .buttons=${n}
        disappearTimeout=${this.shareFloatingToolbarDisappearDebouncer??-1}
        class="floating-toolbar-share"
        @mouseleave=${()=>{this.shareButtonMouseLeave()}}
        @button-clicked=${e=>{this.shareFloatingToolbarButtonClicked(e).then(()=>{},()=>{})}}
      ></euphony-floating-toolbar>
    `;let l=a``;this.showMessageEditorPopover&&this.editorFocusedMessage&&(l=a`
        <euphony-message-editor-popover
          .message=${this.editorFocusedMessage}
          @save-button-clicked=${e=>{this.messageEditorPopoverSaveButtonClicked(e)}}
          @cancel-button-clicked=${()=>{this.messageEditorPopoverCancelButtonClicked()}}
        ></euphony-message-editor-popover>
      `);let d=a``;null!==this.insertMessageMenuIndex&&(d=a`
        <div
          class="add-message-type-menu"
          @click=${e=>{e.stopPropagation()}}
        >
          <button
            class="add-message-type-menu-item"
            @click=${()=>{this.insertMessageAfterIndex(this.insertMessageMenuIndex,"text")}}
          >
            Text
          </button>
          <button
            class="add-message-type-menu-item"
            @click=${()=>{this.insertMessageAfterIndex(this.insertMessageMenuIndex,"system")}}
          >
            System
          </button>
          <button
            class="add-message-type-menu-item"
            @click=${()=>{this.insertMessageAfterIndex(this.insertMessageMenuIndex,"developer")}}
          >
            Developer
          </button>
        </div>
      `);let h=a``,c=a``;if(this.mouseoverMessage&&this.mouseoverMessageIndex){const e=this.mouseoverMessage.role,t=e.charAt(0).toUpperCase()+e.slice(1),s=u(this.mouseoverMessage.content),o=s.charAt(0).toUpperCase()+s.slice(1);h=a`<span
        >${t} ${o} Metadata</span
      >`,c=a`
        <button
          class="icon svg-icon message-share-button"
          ?is-hidden=${!this.hasMessageSharingURLEventListener}
          @mouseenter=${e=>{this.toolButtonMouseEnter(e,"message-share")}}
          @mouseleave=${()=>{this.toolButtonMouseLeave()}}
          @click=${e=>{this.metadataOverlayShareButtonClicked(e,this.mouseoverMessageIndex)}}
        >
          ${r(Z)}
        </button>
      `}let g=a``;this.mouseoverMessage&&(g=this.getMessageMetadataInfo(this.mouseoverMessage));const m=a` <div
      class="message-metadata-overlay"
      ?is-hidden=${!this.isShowingMessageMetadata}
      role="tooltip"
      tabindex="0"
      @mousedown=${()=>{this.metadataMouseDown()}}
      @mouseenter=${()=>{this.metadataOverlayMouseEnter()}}
      @mouseleave=${()=>{this.metadataOverlayMouseLeave()}}
    >
      <div class="metadata-header">
        <div class="metadata-header-name">${h}</div>
        <div class="metadata-header-share-button">${c}</div>
      </div>
      <div class="metadata-info">${g}</div>
      <euphony-json-viewer
        .data=${this.mouseoverMessage?.metadata??null}
        ?is-dark-theme=${this.isDarkTheme}
      >
      </euphony-json-viewer>
      <div class="popper-arrow"></div>
    </div>`;let v=M(this.euphonyStyleConfig),C="--min: 100px;";this.conversationMaxWidth&&(v+=`--conversation-max-width: ${this.conversationMaxWidth}px;`,C+=`--max: ${this.conversationMaxWidth}px;`),this.conversationMinWidth&&(v+=`--conversation-min-width: ${this.conversationMinWidth}px;`,C+=`--min: ${this.conversationMinWidth}px;`);let b=a``;b=this.isShowingMetadata?a`
        <sl-split-panel position="60" style=${C}>
          <div
            class="messages"
            is-showing-metadata=${this.isShowingMessageMetadata}
            slot="start"
          >
            ${t}
          </div>
          <div
            class="metadata"
            is-showing-metadata=${this.isShowingMessageMetadata}
            slot="end"
          >
            <div class="metadata-header">Conversation Metadata</div>
            ${s}
          </div>
          <div class="my-divider" slot="divider"></div>
        </sl-split-panel>
      `:a` <div class="messages">${t}</div> `;const w=a`
      <euphony-preference-window
        ?is-hidden=${this.disablePreferenceButton||!this.isShowingPreferenceWindow}
        .enabledOptions=${{maxMessageHeight:!0,gridView:!1,expandAndCollapseAll:!0,advanced:!0,messageLabel:!0,focusMode:!0}}
        ?is-dark-theme=${this.isDarkTheme}
        @preference-window-close-clicked=${()=>{this.isShowingPreferenceWindow=!1}}
        @max-message-height-changed=${e=>{this.preferenceWindowMaxMessageHeightChanged(e)}}
        @message-label-changed=${e=>{this.preferenceWindowMessageLabelChanged(e)}}
        @expand-all-clicked=${()=>{this.expandBlockContents()}}
        @collapse-all-clicked=${()=>{this.collapseBlockContents()}}
        @translate-all-clicked=${()=>{this.translationButtonClicked()}}
        @focus-mode-settings-changed=${e=>{this.preferenceWindowFocusModeSettingsChanged(e)}}
      ></euphony-preference-window>
    `,y=a`
      <euphony-token-window
        ?is-hidden=${this.disableTokenWindow}
      ></euphony-token-window>
    `;return a`
      ${o} ${m} ${i}
      ${l} ${d}
      ${w} ${y}
      <div
        class="conversation"
        tabindex="0"
        style=${v}
        ?is-dark-theme=${this.isDarkTheme}
      >
        ${e}
        <div class="content">${b}</div>
      </div>
      ${this.loadKatexScript()}
    `}expandBlockContents(){y(this)}collapseBlockContents(){f(this)}};oe.styles=[t`
      ${e($)}
      ${e(k)}
    `],Q([d({type:String,attribute:"conversation-string"})],oe.prototype,"conversationString",2),Q([d({attribute:!1})],oe.prototype,"conversationData",2),Q([d({type:String,attribute:"sharing-url"})],oe.prototype,"sharingURL",2),Q([d({type:String,attribute:"data-file-url"})],oe.prototype,"dataFileURL",2),Q([d({type:String,attribute:"override-sharing-json-string"})],oe.prototype,"overrideSharingJSONString",2),Q([d({type:Boolean,attribute:"should-render-markdown"})],oe.prototype,"shouldRenderMarkdown",2),Q([d({type:Array,attribute:"markdown-allowed-tags"})],oe.prototype,"markdownAllowedTags",2),Q([d({type:Array,attribute:"markdown-allowed-attributes"})],oe.prototype,"markdownAllowedAttributes",2),Q([d({type:String,attribute:"conversation-label"})],oe.prototype,"conversationLabel",2),Q([s()],oe.prototype,"conversation",2),Q([d({type:Boolean,attribute:"is-editable"})],oe.prototype,"isEditable",2),Q([d({type:Array,attribute:"focus-mode-author"})],oe.prototype,"focusModeAuthor",2),Q([d({type:Array,attribute:"focus-mode-recipient"})],oe.prototype,"focusModeRecipient",2),Q([d({type:Array,attribute:"focus-mode-content-type"})],oe.prototype,"focusModeContentType",2),Q([s()],oe.prototype,"focusModeExemptedMessageIndexes",2),Q([s()],oe.prototype,"deletedMessageIndexes",2),Q([s()],oe.prototype,"insertMessageMenuIndex",2),Q([s()],oe.prototype,"showMessageEditorPopover",2),Q([s()],oe.prototype,"editorFocusedMessage",2),Q([s()],oe.prototype,"editorFocusedMessageIndex",2),Q([d({type:Boolean,attribute:"is-convo-marked-for-deletion"})],oe.prototype,"isConvoMarkedForDeletion",2),Q([s()],oe.prototype,"hasMessageSharingURLEventListener",2),Q([s()],oe.prototype,"hasTranslationEventListener",2),Q([s()],oe.prototype,"isShowingTranslation",2),Q([s()],oe.prototype,"isTranslating",2),Q([s()],oe.prototype,"translationProgress",2),Q([s()],oe.prototype,"translationSourceLanguage",2),Q([d({type:Array,attribute:"custom-labels"})],oe.prototype,"customLabels",2),Q([d({type:Array,attribute:"custom-message-labels"})],oe.prototype,"customMessageLabels",2),Q([d({type:Array,attribute:"custom-share-buttons"})],oe.prototype,"customShareButtons",2),Q([o("#popper-tooltip")],oe.prototype,"popperTooltip",2),Q([o(".message-metadata-overlay")],oe.prototype,"messageMetadataOverlay",2),Q([o("euphony-floating-toolbar.floating-toolbar-share")],oe.prototype,"shareFloatingToolbar",2),Q([s()],oe.prototype,"showShareFloatingToolbar",2),Q([o("euphony-token-window")],oe.prototype,"tokenWindowComponent",2),Q([d({type:Boolean,attribute:"is-showing-metadata"})],oe.prototype,"isShowingMetadata",2),Q([s()],oe.prototype,"mouseoverMessage",2),Q([s()],oe.prototype,"isShowingMessageMetadata",2),Q([d({type:Number,attribute:"conversation-max-width"})],oe.prototype,"conversationMaxWidth",2),Q([d({type:Number,attribute:"conversation-min-width"})],oe.prototype,"conversationMinWidth",2),Q([d({type:Boolean,attribute:"disable-markdown-button"})],oe.prototype,"disableMarkdownButton",2),Q([d({type:Boolean,attribute:"disable-translation-button"})],oe.prototype,"disableTranslationButton",2),Q([d({type:Boolean,attribute:"disable-share-button"})],oe.prototype,"disableShareButton",2),Q([d({type:Boolean,attribute:"disable-metadata-button"})],oe.prototype,"disableMetadataButton",2),Q([d({type:Boolean,attribute:"disable-editing-mode-save-button"})],oe.prototype,"disableEditingModeSaveButton",2),Q([d({type:Boolean,attribute:"disable-conversation-id-copy-button"})],oe.prototype,"disableConversationIDCopyButton",2),Q([s()],oe.prototype,"isShowingPreferenceWindow",2),Q([d({type:Boolean,attribute:"disable-message-metadata"})],oe.prototype,"disableMessageMetadata",2),Q([d({type:Boolean,attribute:"disable-conversation-name"})],oe.prototype,"disableConversationName",2),Q([d({type:Boolean,attribute:"disable-preference-button"})],oe.prototype,"disablePreferenceButton",2),Q([d({type:Boolean,attribute:"disable-token-window"})],oe.prototype,"disableTokenWindow",2),Q([d({type:String,attribute:"theme"})],oe.prototype,"theme",2),Q([d({type:Boolean,attribute:"is-dark-theme",reflect:!0})],oe.prototype,"isDarkTheme",2),Q([s()],oe.prototype,"shareFloatingToolbarDisappearDebouncer",2),oe=Q([l("euphony-conversation")],oe);const ne=e=>{try{return JSON.parse(e)}catch(t){return console.error(t),console.error("Error parsing conversation JSON string:",e),null}};export{oe as E,D as a,ne as p};