import Cache from "./cache.js";
const cache = Cache.getInstance();
import {cachedPlayerId} from "./socket.js";
import { friendsList, friendsListSearch } from "./ui.js";

function updateFriendsList(data: any) {

    if (!data?.friends) {
        return;
    }

    const list = Array.from(friendsList.querySelectorAll('.friend-name')) as HTMLElement[];

    list.forEach((item: HTMLElement) => {
        const name = item.innerText.toLowerCase();
        if (!data.friends.map((f: string) => f.toLowerCase()).includes(name)) {
            item.parentElement?.remove();
        }
    });

    data.friends.forEach((friend: string) => {
        const exists = list.some(item => item.innerText.toLowerCase() === friend.toLowerCase());
        if (!exists) {
            const friendElement = document.createElement("div");
            friendElement.classList.add("friend-item", "ui");

            const friendName = document.createElement("div");
            friendName.classList.add("friend-name");
            friendName.classList.add("ui");
            friendName.innerText = friend.charAt(0).toUpperCase() + friend.slice(1);
            friendElement.appendChild(friendName);

            const friendStatus = document.createElement("div");
            const isOnline = cache.onlinePlayers.has(friend.toLowerCase()) && friend.toLowerCase() !== Array.from(cache.players).find((p: any) => p.id === cachedPlayerId)?.username?.toLowerCase();
            friendStatus.classList.add("friend-status", isOnline ? "online" : "offline");
            friendStatus.classList.add("ui");
            friendElement.appendChild(friendStatus);

            friendsList.appendChild(friendElement);
        }
    });
}

function updateFriendOnlineStatus(friendName: string, isOnline: boolean) {
  setTimeout(() => {
    const list = Array.from(friendsList.querySelectorAll('.friend-name')) as HTMLElement[];
    if (!list.length) {
      return;
    }
    list.forEach((item: HTMLElement) => {
      const name = item.innerText.toLowerCase();
      if (name === friendName.toLowerCase()) {
        const statusElement = item.nextElementSibling as HTMLElement;
        if (statusElement) {
          statusElement.classList.toggle("online", isOnline);
          statusElement.classList.toggle("offline", !isOnline);
        }
      }
    });
    }, 2000);
}

export { updateFriendsList, updateFriendOnlineStatus, friendsListSearch };