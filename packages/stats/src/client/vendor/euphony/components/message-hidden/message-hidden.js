import{v as e,i as s,n as t,a,b as r,w as n}from"../../chunks/third-party.js";import{t as i}from"../../chunks/harmony-types.js";import{c as o}from"../../chunks/css/message-hidden.js";var d=Object.defineProperty,c=Object.getOwnPropertyDescriptor,p=(e,s,t,a)=>{for(var r,n=a>1?void 0:a?c(s,t):s,i=e.length-1;i>=0;i--)(r=e[i])&&(n=(a?r(s,t,n):r(n))||n);return a&&n&&d(s,t,n),n};let m=class extends a{constructor(){super(),this.message=null}firstUpdated(){}willUpdate(e){}async initData(){}render(){let e="";return this.message&&(e=(i(this.message.content)??"unsupported").replaceAll("_"," ").toLowerCase()),r`
      <div
        class="message-content"
        @click=${()=>{this.dispatchEvent(new Event("hidden-message-clicked",{bubbles:!0,composed:!0}))}}
      >
        <div class="message-text">Show ${e} message</div>
      </div>
    `}};m.styles=[s`
      ${e(o)}
    `],p([t({attribute:!1})],m.prototype,"message",2),m=p([n("euphony-message-hidden")],m);export{m as EuphonyMessageHidden};