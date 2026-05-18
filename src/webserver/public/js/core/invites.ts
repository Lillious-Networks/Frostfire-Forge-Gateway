import {sendRequest} from "./socket";

export function createInvitationPopup(invitationData: any) {

  const existingPopup = document.getElementById("invitation-popup");
  if (existingPopup) {

    existingPopup.remove();
  }
  const popup = document.createElement("div");
  popup.id = "invitation-popup";
  popup.className = "popup";
  popup.innerHTML = `
    <h2>Invitation</h2>
    <p>${invitationData.message}</p>
    <div class="button-container">
      <button id="accept-invitation">Accept</button>
      <button id="decline-invitation">Decline</button>
    </div>
  `;

  document.body.appendChild(popup);

  const acceptButton = document.getElementById("accept-invitation");
  const declineButton = document.getElementById("decline-invitation");
  let data;

  switch (invitationData.action.toUpperCase()) {
    case "FRIEND_REQUEST": {
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "FRIEND_REQUEST",
        },
      }
    }
    break;
    case "INVITE_PARTY": {
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "INVITE_PARTY",
        },
      }
    }
    break;
    case "INVITE_GUILD": {
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "INVITE_GUILD",
        },
      }
    }
    break;
  }

  if (!data) return;

  acceptButton?.addEventListener("click", () => {
    data.data.response = "ACCEPT";
    sendRequest(data);
    popup.remove();
  });

  declineButton?.addEventListener("click", () => {
    data.data.response = "DECLINE";
    sendRequest(data);
    popup.remove();
  });
}